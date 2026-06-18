package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// dirPrivacyView never exposes the bcrypt hash.
func dirPrivacyView(d store.DirectoryPrivacy) map[string]any {
	return map[string]any{
		"id": d.ID, "domain": d.Domain, "path": d.Path, "username": d.Username,
	}
}

func (s *Server) handleListDirPrivacy(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListDirectoryPrivacy(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list protected paths")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, d := range items {
		views = append(views, dirPrivacyView(d))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"protections": views})
}

type createDirPrivacyRequest struct {
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleCreateDirPrivacy(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createDirPrivacyRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(req.Domain))
	username := strings.TrimSpace(req.Username)
	path := strings.TrimSpace(req.Path)
	if path == "" {
		path = "/*"
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
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not hash password")
		return
	}
	d, err := s.deps.Store.CreateDirectoryPrivacy(ctx, store.CreateDirPrivacyParams{
		OrgID: p.OrgID, Domain: domain, Path: path, Username: username, PasswordHash: string(hash),
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create protection")
		return
	}
	jobID, dispatched := s.applyProtection(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "directory_privacy.create", "directory_privacy", d.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"domain": domain, "path": path, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"protection": dirPrivacyView(*d),
		"dispatch":   map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteDirPrivacy(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "protectionID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteDirectoryPrivacy(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyProtection(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "directory_privacy.delete", "directory_privacy", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyProtection renders every directory-privacy rule (with its bcrypt hash)
// and dispatches protection.apply so the agent regenerates the Caddy snippet.
func (s *Server) applyProtection(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	items, err := s.deps.Store.ListDirectoryPrivacy(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeProtectionApply, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(items))
	for _, d := range items {
		list = append(list, map[string]any{
			"domain": d.Domain, "path": d.Path, "username": d.Username, "password_hash": d.PasswordHash,
		})
	}
	// The same protection.apply job carries hotlink rules so both land in one
	// Caddy site block per domain.
	hotlinks, _ := s.deps.Store.ListHotlink(ctx, p.OrgID)
	hlList := make([]map[string]any, 0, len(hotlinks))
	for _, h := range hotlinks {
		hlList = append(hlList, map[string]any{
			"domain": h.Domain, "allowed_referers": h.AllowedReferers, "extensions": h.Extensions,
		})
	}
	// WebDAV (Web Disk) accounts render into the same per-domain site block.
	davs, _ := s.deps.Store.ListWebdav(ctx, p.OrgID)
	davList := make([]map[string]any, 0, len(davs))
	for _, d := range davs {
		davList = append(davList, map[string]any{
			"domain": d.Domain, "path": d.Path, "username": d.Username,
			"password_hash": d.PasswordHash, "root": d.Root,
		})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeProtectionApply, node.ID,
		map[string]any{"basic_auth": list, "hotlink": hlList, "webdav": davList})
	return jobID, dispatched
}
