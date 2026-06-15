package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

func (s *Server) handleListAPITokens(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	toks, err := s.deps.Store.ListAPITokens(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list tokens")
		return
	}
	views := make([]map[string]any, 0, len(toks))
	for _, t := range toks {
		views = append(views, map[string]any{
			"id":           t.ID,
			"name":         t.Name,
			"prefix":       t.Prefix,
			"scopes":       t.Scopes,
			"last_used_at": t.LastUsedAt,
			"expires_at":   t.ExpiresAt,
			"revoked":      t.RevokedAt != nil,
			"created_at":   t.CreatedAt,
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"api_tokens": views})
}

type createAPITokenRequest struct {
	Name          string   `json:"name"`
	Scopes        []string `json:"scopes"`
	ExpiresInDays int      `json:"expires_in_days"`
}

func (s *Server) handleCreateAPIToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)

	var req createAPITokenRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Name) == "" || len(req.Scopes) == 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "name and at least one scope are required")
		return
	}

	// No privilege escalation: a token can only carry scopes the creator holds.
	for _, sc := range req.Scopes {
		if !p.Can(sc) {
			httpx.Error(w, http.StatusForbidden, "forbidden", "cannot grant a scope you do not hold: "+sc)
			return
		}
	}

	prefix, _ := crypto.RandomHex(6)  // 12 hex chars, lookup key
	secret, _ := crypto.RandomHex(32) // 64 hex chars
	token := "astp_" + prefix + "_" + secret

	var expiresAt *time.Time
	if req.ExpiresInDays > 0 {
		t := time.Now().AddDate(0, 0, req.ExpiresInDays)
		expiresAt = &t
	}

	id, err := s.deps.Store.CreateAPIToken(ctx, p.OrgID, uuid.NullUUID{UUID: p.UserID, Valid: true},
		req.Name, prefix, crypto.SHA256([]byte(token)), req.Scopes, expiresAt)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create token (name may already exist)")
		return
	}

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "apitoken.create", "api_token", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"scopes": req.Scopes})

	// The secret is returned exactly once.
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id":         id,
		"name":       req.Name,
		"prefix":     prefix,
		"scopes":     req.Scopes,
		"token":      token,
		"expires_at": expiresAt,
	})
}

func (s *Server) handleRevokeAPIToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "tokenID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid token id")
		return
	}
	if err := s.deps.Store.RevokeAPIToken(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not revoke token")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "apitoken.revoke", "api_token", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"revoked": true})
}
