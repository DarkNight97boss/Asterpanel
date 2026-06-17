package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// webauthnUser adapts a stored user + its passkeys to the webauthn.User interface.
type webauthnUser struct {
	id      []byte
	name    string
	display string
	creds   []webauthn.Credential
}

func (u *webauthnUser) WebAuthnID() []byte                         { return u.id }
func (u *webauthnUser) WebAuthnName() string                       { return u.name }
func (u *webauthnUser) WebAuthnDisplayName() string                { return u.display }
func (u *webauthnUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func buildWAUser(u *store.User, creds []store.WebAuthnCredential) *webauthnUser {
	display := u.Email
	if u.FullName != nil && *u.FullName != "" {
		display = *u.FullName
	}
	wc := make([]webauthn.Credential, 0, len(creds))
	for _, c := range creds {
		wc = append(wc, webauthn.Credential{
			ID:        c.CredentialID,
			PublicKey: c.PublicKey,
			Authenticator: webauthn.Authenticator{
				AAGUID:    c.AAGUID,
				SignCount: uint32(c.SignCount),
			},
		})
	}
	return &webauthnUser{id: u.ID[:], name: u.Email, display: display, creds: wc}
}

func (s *Server) webauthnReady(w http.ResponseWriter) bool {
	if s.deps.WebAuthn == nil || s.deps.Redis == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "passkeys require WebAuthn + Redis to be configured")
		return false
	}
	return true
}

// --- Registration (authenticated) -------------------------------------------

func (s *Server) handleWebAuthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	if !s.webauthnReady(w) {
		return
	}
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	user, err := s.deps.Store.GetUserByID(ctx, p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "user lookup failed")
		return
	}
	creds, _ := s.deps.Store.ListWebAuthnCredentials(ctx, p.UserID)
	options, session, err := s.deps.WebAuthn.BeginRegistration(buildWAUser(user, creds))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not begin registration")
		return
	}
	sd, _ := json.Marshal(session)
	s.deps.Redis.Set(ctx, "wa:reg:"+p.UserID.String(), sd, 5*time.Minute)
	httpx.JSON(w, http.StatusOK, options)
}

func (s *Server) handleWebAuthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	if !s.webauthnReady(w) {
		return
	}
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	raw, err := s.deps.Redis.Get(ctx, "wa:reg:"+p.UserID.String()).Bytes()
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "no_session", "no registration in progress")
		return
	}
	var session webauthn.SessionData
	if jerr := json.Unmarshal(raw, &session); jerr != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "corrupt session")
		return
	}
	user, err := s.deps.Store.GetUserByID(ctx, p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "user lookup failed")
		return
	}
	creds, _ := s.deps.Store.ListWebAuthnCredentials(ctx, p.UserID)
	cred, err := s.deps.WebAuthn.FinishRegistration(buildWAUser(user, creds), session, r)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "verification_failed", "passkey registration could not be verified")
		return
	}
	var name *string
	if n := strings.TrimSpace(r.URL.Query().Get("name")); n != "" {
		name = &n
	}
	if cerr := s.deps.Store.CreateWebAuthnCredential(ctx, p.UserID, store.WebAuthnCredential{
		CredentialID: cred.ID, PublicKey: cred.PublicKey, AAGUID: cred.Authenticator.AAGUID,
		SignCount: int64(cred.Authenticator.SignCount), Name: name,
	}); cerr != nil {
		httpx.Error(w, http.StatusConflict, "store_failed", "could not store passkey (already registered?)")
		return
	}
	s.deps.Redis.Del(ctx, "wa:reg:"+p.UserID.String())
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "webauthn.register", "user", p.UserID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusCreated, map[string]any{"registered": true})
}

// --- Login (public) ---------------------------------------------------------

type webauthnLoginBeginRequest struct {
	Email string `json:"email"`
}

type loginSession struct {
	Session webauthn.SessionData `json:"session"`
	UserID  uuid.UUID            `json:"user_id"`
}

func (s *Server) handleWebAuthnLoginBegin(w http.ResponseWriter, r *http.Request) {
	if !s.webauthnReady(w) {
		return
	}
	ctx := r.Context()
	var req webauthnLoginBeginRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Email) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "email is required")
		return
	}
	user, err := s.deps.Store.GetUserByEmail(ctx, strings.ToLower(strings.TrimSpace(req.Email)))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "no_passkey", "no passkey is registered for this account")
		return
	}
	creds, _ := s.deps.Store.ListWebAuthnCredentials(ctx, user.ID)
	if len(creds) == 0 {
		httpx.Error(w, http.StatusNotFound, "no_passkey", "no passkey is registered for this account")
		return
	}
	assertion, session, err := s.deps.WebAuthn.BeginLogin(buildWAUser(user, creds))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not begin login")
		return
	}
	token := uuid.NewString()
	sd, _ := json.Marshal(loginSession{Session: *session, UserID: user.ID})
	s.deps.Redis.Set(ctx, "wa:login:"+token, sd, 5*time.Minute)
	httpx.JSON(w, http.StatusOK, map[string]any{"assertion": assertion, "login_token": token})
}

func (s *Server) handleWebAuthnLoginFinish(w http.ResponseWriter, r *http.Request) {
	if !s.webauthnReady(w) {
		return
	}
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	if token == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "login token is required")
		return
	}
	raw, err := s.deps.Redis.Get(ctx, "wa:login:"+token).Bytes()
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "no_session", "login session expired")
		return
	}
	var ls loginSession
	if jerr := json.Unmarshal(raw, &ls); jerr != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "corrupt session")
		return
	}
	user, err := s.deps.Store.GetUserByID(ctx, ls.UserID)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid_credentials", "could not verify passkey")
		return
	}
	creds, _ := s.deps.Store.ListWebAuthnCredentials(ctx, user.ID)
	cred, err := s.deps.WebAuthn.FinishLogin(buildWAUser(user, creds), ls.Session, r)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid_credentials", "passkey verification failed")
		return
	}
	_ = s.deps.Store.UpdateWebAuthnSignCount(ctx, cred.ID, int64(cred.Authenticator.SignCount))
	s.deps.Redis.Del(ctx, "wa:login:"+token)
	// A passkey is a strong authenticator — the session is fully authenticated.
	s.completeLogin(w, r, user, true)
}

// --- Management -------------------------------------------------------------

func (s *Server) handleListPasskeys(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	creds, err := s.deps.Store.ListWebAuthnCredentials(ctx, p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list passkeys")
		return
	}
	views := make([]map[string]any, 0, len(creds))
	for _, c := range creds {
		views = append(views, map[string]any{
			"id":   uuid.NewSHA1(uuid.Nil, c.CredentialID).String(), // stable display id
			"name": c.Name,
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"passkeys": views})
}
