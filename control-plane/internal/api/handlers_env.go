package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

// --- Environment variables ---------------------------------------------------

func (s *Server) handleListEnv(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	vars, err := s.deps.Store.ListEnvVars(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list env vars")
		return
	}
	views := make([]map[string]any, 0, len(vars))
	for _, e := range vars {
		views = append(views, map[string]any{"id": e.ID, "key": e.Key, "value": e.Value, "is_build_time": e.IsBuildTime})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"variables": views})
}

type createEnvRequest struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	IsBuildTime bool   `json:"is_build_time"`
}

func (s *Server) handleCreateEnv(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createEnvRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Key) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "key is required")
		return
	}
	e, err := s.deps.Store.UpsertEnvVar(ctx, p.OrgID, req.Key, req.Value, req.IsBuildTime)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not save env var")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "env.set", "env_var", e.ID.String(), audit.OutcomeSuccess, r, map[string]any{"key": req.Key})
	httpx.JSON(w, http.StatusCreated, map[string]any{"variable": map[string]any{"id": e.ID, "key": e.Key, "value": e.Value, "is_build_time": e.IsBuildTime}})
}

func (s *Server) handleDeleteEnv(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "envID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteEnvVar(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "env.delete", "env_var", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// --- Secrets (org-level) -----------------------------------------------------

func (s *Server) handleListSecrets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	secs, err := s.deps.Store.ListOrgSecrets(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list secrets")
		return
	}
	views := make([]map[string]any, 0, len(secs))
	for _, m := range secs {
		views = append(views, map[string]any{"id": m.ID, "key": m.Key, "version": m.Version, "updated_at": m.UpdatedAt})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"secrets": views})
}

type createSecretRequest struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func (s *Server) handleCreateSecret(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createSecretRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Key) == "" || req.Value == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "key and value are required")
		return
	}
	aad := []byte("orgsecret:" + p.OrgID.String() + ":" + req.Key)
	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(req.Value), aad)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal secret")
		return
	}
	id, err := s.deps.Store.UpsertOrgSecret(ctx, p.OrgID, req.Key, ct, nonce, s.deps.Envelope.KeyID())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store secret")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "secret.set", "secret", id.String(), audit.OutcomeSuccess, r, map[string]any{"key": req.Key})
	// The value is never returned.
	httpx.JSON(w, http.StatusCreated, map[string]any{"secret": map[string]any{"id": id, "key": req.Key}})
}

func (s *Server) handleDeleteSecret(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "secretID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteSecret(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "secret.delete", "secret", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
