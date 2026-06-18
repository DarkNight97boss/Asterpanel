package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func webdavView(a store.WebdavAccount) map[string]any {
	return map[string]any{
		"id": a.ID, "domain": a.Domain, "path": a.Path, "username": a.Username, "root": a.Root,
	}
}

func (s *Server) handleListWebdav(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListWebdav(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list web disks")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, a := range items {
		views = append(views, webdavView(a))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"webdav": views})
}

type createWebdavRequest struct {
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Username string `json:"username"`
	Password string `json:"password"`
	Root     string `json:"root"`
}

func (s *Server) handleCreateWebdav(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createWebdavRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(req.Domain))
	username := strings.TrimSpace(req.Username)
	path := strings.TrimSpace(req.Path)
	root := strings.TrimSpace(req.Root)
	if path == "" {
		path = "/webdav/*"
	}
	if !strings.Contains(domain, ".") || strings.ContainsAny(domain, " /") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid domain is required")
		return
	}
	if username == "" || len(req.Password) < 6 {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "username and a password (min 6 chars) are required")
		return
	}
	if !strings.HasPrefix(path, "/") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "path must start with /")
		return
	}
	// The served root must be an absolute path and may not escape upward.
	if !strings.HasPrefix(root, "/") || strings.Contains(root, "..") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "root must be an absolute path")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not hash password")
		return
	}
	a, err := s.deps.Store.CreateWebdav(ctx, store.CreateWebdavParams{
		OrgID: p.OrgID, Domain: domain, Path: path, Username: username,
		PasswordHash: string(hash), Root: root,
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create web disk (already exists?)")
		return
	}
	jobID, dispatched := s.applyProtection(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "webdav.create", "webdav_account", a.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"domain": domain, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"webdav":   webdavView(*a),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteWebdav(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "webdavID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteWebdav(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyProtection(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "webdav.delete", "webdav_account", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
