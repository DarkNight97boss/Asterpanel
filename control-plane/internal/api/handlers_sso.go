package api

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// ssoSecretAAD binds a provider's encrypted client secret to its owning org.
func ssoSecretAAD(orgID uuid.UUID) []byte { return []byte("sso-client-secret|" + orgID.String()) }

// ssoProviderView never exposes the client secret.
func ssoProviderView(p store.SSOProvider) map[string]any {
	return map[string]any{
		"id": p.ID, "name": p.Name, "issuer": p.Issuer, "client_id": p.ClientID,
		"allowed_domains": p.AllowedDomains, "enabled": p.Enabled, "created_at": p.CreatedAt,
	}
}

func (s *Server) handleListSSOProviders(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	providers, err := s.deps.Store.ListSSOProvidersForOrg(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list SSO providers")
		return
	}
	views := make([]map[string]any, 0, len(providers))
	for _, pr := range providers {
		views = append(views, ssoProviderView(pr))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"providers": views})
}

type createSSOProviderRequest struct {
	Name           string `json:"name"`
	Issuer         string `json:"issuer"`
	ClientID       string `json:"client_id"`
	ClientSecret   string `json:"client_secret"`
	AllowedDomains string `json:"allowed_domains"`
	Enabled        *bool  `json:"enabled"`
}

func (s *Server) handleCreateSSOProvider(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createSSOProviderRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Issuer = strings.TrimRight(strings.TrimSpace(req.Issuer), "/")
	req.ClientID = strings.TrimSpace(req.ClientID)
	if req.Name == "" || req.ClientID == "" || req.ClientSecret == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "name, client_id and client_secret are required")
		return
	}
	u, err := url.Parse(req.Issuer)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "issuer must be an https URL")
		return
	}

	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(req.ClientSecret), ssoSecretAAD(p.OrgID))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal client secret")
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	provider, err := s.deps.Store.CreateSSOProvider(ctx, store.CreateSSOProviderParams{
		OrgID: p.OrgID, Name: req.Name, Issuer: req.Issuer, ClientID: req.ClientID,
		ClientSecretCT: ct, ClientSecretNonce: nonce, ClientSecretKeyID: s.deps.Envelope.KeyID(),
		AllowedDomains: strings.TrimSpace(req.AllowedDomains), Enabled: enabled,
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create provider (issuer may already exist)")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "sso.provider.create", "sso_provider", provider.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"issuer": provider.Issuer})
	httpx.JSON(w, http.StatusCreated, map[string]any{"provider": ssoProviderView(*provider)})
}

type updateSSOProviderRequest struct {
	Name           string `json:"name"`
	ClientID       string `json:"client_id"`
	ClientSecret   string `json:"client_secret"`
	AllowedDomains string `json:"allowed_domains"`
	Enabled        *bool  `json:"enabled"`
}

// handleUpdateSSOProvider edits a provider's name, client id, allowed domains and
// enabled flag; a non-empty client_secret rotates the (encrypted) secret. The
// issuer is the key and cannot be changed.
func (s *Server) handleUpdateSSOProvider(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "providerID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid provider id")
		return
	}
	var req updateSSOProviderRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.ClientID = strings.TrimSpace(req.ClientID)
	if req.Name == "" || req.ClientID == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "name and client_id are required")
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	provider, err := s.deps.Store.UpdateSSOProvider(ctx, p.OrgID, id, req.Name, req.ClientID, strings.TrimSpace(req.AllowedDomains), enabled)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "provider not found")
		return
	}
	if req.ClientSecret != "" {
		ct, nonce, eerr := s.deps.Envelope.Encrypt([]byte(req.ClientSecret), ssoSecretAAD(p.OrgID))
		if eerr != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal client secret")
			return
		}
		if uerr := s.deps.Store.UpdateSSOProviderSecret(ctx, p.OrgID, id, ct, nonce, s.deps.Envelope.KeyID()); uerr != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store client secret")
			return
		}
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "sso.provider.update", "sso_provider", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"enabled": enabled})
	httpx.JSON(w, http.StatusOK, map[string]any{"provider": ssoProviderView(*provider)})
}

func (s *Server) handleDeleteSSOProvider(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "providerID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid provider id")
		return
	}
	if err := s.deps.Store.DeleteSSOProvider(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete provider")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "sso.provider.delete", "sso_provider", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
