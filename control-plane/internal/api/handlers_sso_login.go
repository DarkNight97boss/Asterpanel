package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/oidc"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

var ssoHTTPClient = &http.Client{Timeout: 15 * time.Second}

// ssoFlowState is parked in Redis between /start and /callback, keyed by the
// anti-CSRF state. It carries the PKCE verifier and the nonce we must see back.
type ssoFlowState struct {
	ProviderID  string `json:"provider_id"`
	Nonce       string `json:"nonce"`
	Verifier    string `json:"verifier"`
	RedirectURI string `json:"redirect_uri"`
}

// handlePublicSSOProviders lists enabled providers (id + name only) so the
// pre-auth login page can render "Sign in with …" buttons.
func (s *Server) handlePublicSSOProviders(w http.ResponseWriter, r *http.Request) {
	providers, err := s.deps.Store.ListEnabledSSOProviders(r.Context())
	if err != nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"providers": []any{}})
		return
	}
	out := make([]map[string]any, 0, len(providers))
	for _, p := range providers {
		out = append(out, map[string]any{"id": p.ID, "name": p.Name})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"providers": out})
}

func (s *Server) ssoCallbackURL(providerID string) string {
	return strings.TrimRight(s.deps.Cfg.PublicURL, "/") + "/api/v1/auth/sso/" + providerID + "/callback"
}

func (s *Server) ssoLoginRedirect(w http.ResponseWriter, r *http.Request, errCode string) {
	target := strings.TrimRight(s.deps.Cfg.WebURL, "/") + "/login"
	if errCode != "" {
		target += "?sso_error=" + url.QueryEscape(errCode)
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
}

// handleSSOStart kicks off the Authorization Code + PKCE flow and redirects the
// browser to the IdP.
func (s *Server) handleSSOStart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if s.deps.Redis == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "SSO store unavailable")
		return
	}
	providerID := chi.URLParam(r, "providerID")
	id, err := uuid.Parse(providerID)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid provider id")
		return
	}
	provider, err := s.deps.Store.GetSSOProvider(ctx, id)
	if err != nil || !provider.Enabled {
		httpx.Error(w, http.StatusNotFound, "not_found", "unknown SSO provider")
		return
	}
	meta, err := oidc.Discover(ctx, ssoHTTPClient, provider.Issuer)
	if err != nil {
		httpx.Error(w, http.StatusBadGateway, "sso_discovery_failed", "could not reach the identity provider")
		return
	}

	state, _ := crypto.RandomTokenURL(24)
	nonce, _ := crypto.RandomTokenURL(24)
	verifier, _ := crypto.RandomTokenURL(48)
	redirectURI := s.ssoCallbackURL(providerID)

	flow, _ := json.Marshal(ssoFlowState{ProviderID: providerID, Nonce: nonce, Verifier: verifier, RedirectURI: redirectURI})
	if err := s.deps.Redis.Set(ctx, "sso:state:"+state, flow, 10*time.Minute).Err(); err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "sso_unavailable", "could not start SSO")
		return
	}

	authURL := oidc.AuthCodeURL(meta, provider.ClientID, redirectURI, state, nonce,
		oidc.S256Challenge(verifier), []string{"openid", "email", "profile"})
	http.Redirect(w, r, authURL, http.StatusSeeOther)
}

// handleSSOCallback completes the flow: it validates state, exchanges the code,
// verifies the ID token, maps the verified email to an existing user and starts
// a session, then redirects back to the panel.
func (s *Server) handleSSOCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if s.deps.Redis == nil {
		s.ssoLoginRedirect(w, r, "unavailable")
		return
	}
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		s.ssoLoginRedirect(w, r, e)
		return
	}
	code, state := q.Get("code"), q.Get("state")
	if code == "" || state == "" {
		s.ssoLoginRedirect(w, r, "invalid_response")
		return
	}

	// One-time state: load and immediately delete (defends against replay).
	raw, err := s.deps.Redis.Get(ctx, "sso:state:"+state).Result()
	if err != nil {
		s.ssoLoginRedirect(w, r, "invalid_state")
		return
	}
	_ = s.deps.Redis.Del(ctx, "sso:state:"+state).Err()
	var flow ssoFlowState
	if err := json.Unmarshal([]byte(raw), &flow); err != nil || flow.ProviderID != chi.URLParam(r, "providerID") {
		s.ssoLoginRedirect(w, r, "invalid_state")
		return
	}

	provider, err := s.deps.Store.GetSSOProvider(ctx, uuid.MustParse(flow.ProviderID))
	if err != nil || !provider.Enabled {
		s.ssoLoginRedirect(w, r, "unknown_provider")
		return
	}
	secret, err := s.deps.Envelope.Decrypt(provider.ClientSecretCT, provider.ClientSecretNonce, ssoSecretAAD(provider.OrganizationID))
	if err != nil {
		s.ssoLoginRedirect(w, r, "config_error")
		return
	}
	meta, err := oidc.Discover(ctx, ssoHTTPClient, provider.Issuer)
	if err != nil {
		s.ssoLoginRedirect(w, r, "discovery_failed")
		return
	}
	idToken, err := oidc.ExchangeCode(ctx, ssoHTTPClient, meta, provider.ClientID, string(secret), code, flow.RedirectURI, flow.Verifier)
	if err != nil {
		s.ssoLoginRedirect(w, r, "exchange_failed")
		return
	}
	jwks, err := oidc.FetchJWKS(ctx, ssoHTTPClient, meta.JWKSURI)
	if err != nil {
		s.ssoLoginRedirect(w, r, "jwks_failed")
		return
	}
	claims, err := oidc.ValidateIDToken(idToken, jwks, provider.Issuer, provider.ClientID, flow.Nonce, time.Now())
	if err != nil {
		s.audit(ctx, &provider.OrganizationID, nil, "auth.sso", "sso_provider", provider.ID.String(), audit.OutcomeFailure, r,
			map[string]any{"reason": "invalid_id_token"})
		s.ssoLoginRedirect(w, r, "invalid_token")
		return
	}

	email := strings.ToLower(strings.TrimSpace(claims.Email))
	if email == "" || !ssoDomainAllowed(email, provider.AllowedDomains) {
		s.ssoLoginRedirect(w, r, "email_not_allowed")
		return
	}
	user, err := s.deps.Store.GetUserByEmail(ctx, email)
	if err != nil || user.Status != "active" {
		// SSO authenticates existing users; it never auto-provisions accounts.
		s.audit(ctx, &provider.OrganizationID, nil, "auth.sso", "user", email, audit.OutcomeFailure, r,
			map[string]any{"reason": "no_account"})
		s.ssoLoginRedirect(w, r, "no_account")
		return
	}

	if err := s.establishSSOSession(w, r, user); err != nil {
		s.ssoLoginRedirect(w, r, "session_error")
		return
	}
	http.Redirect(w, r, strings.TrimRight(s.deps.Cfg.WebURL, "/")+"/dashboard", http.StatusSeeOther)
}

// establishSSOSession mirrors completeLogin's session/refresh/cookie issuance but
// for the redirect-based SSO flow (no JSON body). The IdP performed the
// authentication, so the session is marked MFA-satisfied.
func (s *Server) establishSSOSession(w http.ResponseWriter, r *http.Request, user *store.User) error {
	ctx := r.Context()
	now := time.Now()
	var orgID uuid.NullUUID
	if m, err := s.deps.Store.PrimaryMembership(ctx, user.ID); err == nil {
		orgID = uuid.NullUUID{UUID: m.OrganizationID, Valid: true}
	}
	ua := r.UserAgent()
	ip := clientIP(r)
	sessionID, err := s.deps.Store.CreateSession(ctx, store.CreateSessionParams{
		UserID: user.ID, OrgID: orgID, UserAgent: &ua, IP: &ip, MFA: true,
		ExpiresAt: now.Add(s.deps.Cfg.RefreshTTL),
	})
	if err != nil {
		return err
	}
	refreshToken, _ := crypto.RandomTokenURL(32)
	if _, err := s.deps.Store.IssueRefreshToken(ctx, sessionID, user.ID, crypto.SHA256([]byte(refreshToken)), now.Add(s.deps.Cfg.RefreshTTL)); err != nil {
		return err
	}
	csrf, _ := crypto.RandomTokenURL(24)
	s.setAuthCookies(w, refreshToken, csrf)
	_ = s.deps.Store.RecordLoginSuccess(ctx, user.ID)

	var orgPtr *uuid.UUID
	if orgID.Valid {
		orgPtr = &orgID.UUID
	}
	s.audit(ctx, orgPtr, &user.ID, "auth.login", "session", sessionID.String(), audit.OutcomeSuccess, r,
		map[string]any{"method": "sso"})
	return nil
}

// ssoDomainAllowed enforces the provider's comma-separated allow-list of email
// domains. An empty list allows any verified email.
func ssoDomainAllowed(email, allowed string) bool {
	allowed = strings.TrimSpace(allowed)
	if allowed == "" {
		return true
	}
	at := strings.LastIndex(email, "@")
	if at < 0 {
		return false
	}
	dom := strings.ToLower(email[at+1:])
	for _, d := range strings.Split(allowed, ",") {
		if strings.ToLower(strings.TrimSpace(d)) == dom {
			return true
		}
	}
	return false
}
