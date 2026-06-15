package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/auth"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req loginRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	if strings.TrimSpace(req.Email) == "" || req.Password == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "email and password are required")
		return
	}

	user, err := s.deps.Store.GetUserByEmail(ctx, req.Email)
	if err != nil {
		// Generic message to avoid account enumeration.
		httpx.Error(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}
	if user.Status != "active" || (user.LockedUntil != nil && user.LockedUntil.After(time.Now())) {
		httpx.Error(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}

	ok, err := crypto.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil || !ok {
		_ = s.deps.Store.RecordLoginFailure(ctx, user.ID)
		s.audit(ctx, nil, &user.ID, "auth.login", "user", user.ID.String(), audit.OutcomeFailure, r, nil)
		httpx.Error(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}
	_ = s.deps.Store.RecordLoginSuccess(ctx, user.ID)

	// Second factor required?
	if totp, terr := s.deps.Store.GetTOTP(ctx, user.ID); terr == nil && totp.Confirmed {
		if s.deps.Redis == nil {
			httpx.Error(w, http.StatusServiceUnavailable, "mfa_unavailable", "MFA store unavailable")
			return
		}
		challenge, _ := crypto.RandomTokenURL(32)
		if err := s.deps.Redis.Set(ctx, "mfa:"+challenge, user.ID.String(), 5*time.Minute).Err(); err != nil {
			httpx.Error(w, http.StatusServiceUnavailable, "mfa_unavailable", "could not start MFA")
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"mfa_required": true,
			"methods":      []string{"totp"},
			"mfa_token":    challenge,
		})
		return
	}

	s.completeLogin(w, r, user, false)
}

type mfaVerifyRequest struct {
	MFAToken string `json:"mfa_token"`
	Code     string `json:"code"`
}

func (s *Server) handleMFAVerify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req mfaVerifyRequest
	if err := httpx.Decode(w, r, &req); err != nil || req.MFAToken == "" || req.Code == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "mfa_token and code are required")
		return
	}
	if s.deps.Redis == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "mfa_unavailable", "MFA store unavailable")
		return
	}
	uidStr, err := s.deps.Redis.Get(ctx, "mfa:"+req.MFAToken).Result()
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "mfa_invalid", "invalid or expired MFA token")
		return
	}
	userID, err := uuid.Parse(uidStr)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "mfa_invalid", "invalid MFA token")
		return
	}
	user, err := s.deps.Store.GetUserByID(ctx, userID)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "mfa_invalid", "invalid MFA token")
		return
	}
	totp, err := s.deps.Store.GetTOTP(ctx, userID)
	if err != nil || !totp.Confirmed {
		httpx.Error(w, http.StatusUnauthorized, "mfa_invalid", "MFA not configured")
		return
	}
	secret, err := s.deps.Envelope.Decrypt(totp.Ciphertext, totp.Nonce, totpAAD(userID))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not read MFA secret")
		return
	}
	if !auth.ValidateTOTP(req.Code, string(secret)) {
		_ = s.deps.Store.RecordLoginFailure(ctx, userID)
		s.audit(ctx, nil, &userID, "auth.mfa", "user", userID.String(), audit.OutcomeFailure, r, map[string]any{"method": "totp"})
		httpx.Error(w, http.StatusUnauthorized, "mfa_invalid", "invalid code")
		return
	}
	_ = s.deps.Redis.Del(ctx, "mfa:"+req.MFAToken).Err()
	s.completeLogin(w, r, user, true)
}

// completeLogin creates the session, issues the rotating refresh token + access
// JWT, sets cookies and audits a successful login.
func (s *Server) completeLogin(w http.ResponseWriter, r *http.Request, user *store.User, mfa bool) {
	ctx := r.Context()
	now := time.Now()

	var orgID uuid.NullUUID
	if m, err := s.deps.Store.PrimaryMembership(ctx, user.ID); err == nil {
		orgID = uuid.NullUUID{UUID: m.OrganizationID, Valid: true}
	}

	ua := r.UserAgent()
	ip := clientIP(r)
	sessionID, err := s.deps.Store.CreateSession(ctx, store.CreateSessionParams{
		UserID: user.ID, OrgID: orgID, UserAgent: &ua, IP: &ip, MFA: mfa,
		ExpiresAt: now.Add(s.deps.Cfg.RefreshTTL),
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create session")
		return
	}

	refreshToken, _ := crypto.RandomTokenURL(32)
	if _, err := s.deps.Store.IssueRefreshToken(ctx, sessionID, user.ID, crypto.SHA256([]byte(refreshToken)), now.Add(s.deps.Cfg.RefreshTTL)); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not issue refresh token")
		return
	}

	var orgUUID uuid.UUID
	if orgID.Valid {
		orgUUID = orgID.UUID
	}
	access, err := s.deps.JWT.Issue(user.ID, orgUUID, sessionID, mfa, user.IsSuperadmin, nil, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not issue access token")
		return
	}

	csrf, _ := crypto.RandomTokenURL(24)
	s.setAuthCookies(w, refreshToken, csrf)

	var orgPtr *uuid.UUID
	if orgID.Valid {
		orgPtr = &orgID.UUID
	}
	s.audit(ctx, orgPtr, &user.ID, "auth.login", "session", sessionID.String(), audit.OutcomeSuccess, r, map[string]any{"mfa": mfa})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"access_token": access,
		"token_type":   "Bearer",
		"expires_in":   int(s.deps.JWT.TTL().Seconds()),
		"csrf_token":   csrf,
		"user":         userView(user, orgID),
	})
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cookie, err := r.Cookie("asterpanel_refresh")
	if err != nil || cookie.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "missing refresh token")
		return
	}
	now := time.Now()
	newToken, _ := crypto.RandomTokenURL(32)
	res, err := s.deps.Store.RotateRefreshToken(ctx,
		crypto.SHA256([]byte(cookie.Value)), crypto.SHA256([]byte(newToken)),
		now.Add(s.deps.Cfg.RefreshTTL), now)
	if err != nil {
		s.clearAuthCookies(w)
		if errors.Is(err, store.ErrRefreshReuse) {
			// Stolen-token replay: the family + sessions were revoked. Loud audit.
			s.audit(ctx, nil, nil, "auth.refresh.reuse", "session", "", audit.OutcomeFailure, r,
				map[string]any{"alert": "refresh_token_reuse"})
			httpx.Error(w, http.StatusUnauthorized, "token_reuse", "refresh token reuse detected; sessions revoked")
			return
		}
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "invalid or expired refresh token")
		return
	}

	user, err := s.deps.Store.GetUserByID(ctx, res.UserID)
	if err != nil {
		s.clearAuthCookies(w)
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "user not found")
		return
	}
	var orgUUID uuid.UUID
	if res.OrgID.Valid {
		orgUUID = res.OrgID.UUID
	}
	access, err := s.deps.JWT.Issue(res.UserID, orgUUID, res.SessionID, true, user.IsSuperadmin, nil, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not issue access token")
		return
	}

	csrf, _ := crypto.RandomTokenURL(24)
	s.setAuthCookies(w, newToken, csrf)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"access_token": access,
		"token_type":   "Bearer",
		"expires_in":   int(s.deps.JWT.TTL().Seconds()),
		"csrf_token":   csrf,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if p := middleware.PrincipalFrom(ctx); p != nil && p.SessionID != uuid.Nil {
		_ = s.deps.Store.RevokeSession(ctx, p.SessionID, "logout")
		org := p.OrgID
		s.audit(ctx, &org, &p.UserID, "auth.logout", "session", p.SessionID.String(), audit.OutcomeSuccess, r, nil)
	}
	s.clearAuthCookies(w)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	user, err := s.deps.Store.GetUserByID(ctx, p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"user":        userView(user, uuid.NullUUID{UUID: p.OrgID, Valid: p.OrgID != uuid.Nil}),
		"permissions": p.Permissions.Keys(),
		"superadmin":  p.Superadmin,
	})
}

// --- TOTP enrollment ----------------------------------------------------------

func totpAAD(userID uuid.UUID) []byte { return []byte("totp|" + userID.String()) }

func (s *Server) handleTOTPEnroll(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	user, err := s.deps.Store.GetUserByID(ctx, p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	cfg, err := auth.GenerateTOTP(s.deps.Cfg.WebAuthnRPName, user.Email)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate TOTP")
		return
	}
	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(cfg.Secret), totpAAD(p.UserID))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal TOTP secret")
		return
	}
	if err := s.deps.Store.UpsertTOTP(ctx, p.UserID, ct, nonce, s.deps.Envelope.KeyID()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store TOTP")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "auth.totp.enroll", "user", p.UserID.String(), audit.OutcomeSuccess, r, nil)
	// The otpauth URL/secret is shown once so the user can add it to an authenticator.
	httpx.JSON(w, http.StatusOK, map[string]any{"otpauth_url": cfg.URL, "secret": cfg.Secret})
}

type totpConfirmRequest struct {
	Code string `json:"code"`
}

func (s *Server) handleTOTPConfirm(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req totpConfirmRequest
	if err := httpx.Decode(w, r, &req); err != nil || req.Code == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "code is required")
		return
	}
	totp, err := s.deps.Store.GetTOTP(ctx, p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "totp_not_enrolled", "enroll TOTP first")
		return
	}
	secret, err := s.deps.Envelope.Decrypt(totp.Ciphertext, totp.Nonce, totpAAD(p.UserID))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not read TOTP secret")
		return
	}
	if !auth.ValidateTOTP(req.Code, string(secret)) {
		httpx.Error(w, http.StatusBadRequest, "totp_invalid", "invalid code")
		return
	}
	_ = s.deps.Store.ConfirmTOTP(ctx, p.UserID)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "auth.totp.confirm", "user", p.UserID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"confirmed": true})
}
