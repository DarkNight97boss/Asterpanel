package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

var validRedirectCode = map[int]bool{301: true, 302: true, 307: true, 308: true}

func redirectView(r store.Redirect) map[string]any {
	return map[string]any{
		"id": r.ID, "source_domain": r.SourceDomain, "source_path": r.SourcePath,
		"target_url": r.TargetURL, "status_code": r.StatusCode,
	}
}

func (s *Server) handleListRedirects(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListRedirects(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list redirects")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, rd := range items {
		views = append(views, redirectView(rd))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"redirects": views})
}

type createRedirectRequest struct {
	SourceDomain string `json:"source_domain"`
	SourcePath   string `json:"source_path"`
	TargetURL    string `json:"target_url"`
	StatusCode   int    `json:"status_code"`
}

func (s *Server) handleCreateRedirect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createRedirectRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(req.SourceDomain))
	target := strings.TrimSpace(req.TargetURL)
	path := strings.TrimSpace(req.SourcePath)
	if path == "" {
		path = "*"
	}
	if !strings.Contains(domain, ".") || strings.ContainsAny(domain, " /") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid source domain is required")
		return
	}
	if !(strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") || strings.HasPrefix(target, "/")) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "target must be an absolute URL or a root-relative path")
		return
	}
	if path != "*" && !strings.HasPrefix(path, "/") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "source path must be * or start with /")
		return
	}
	code := req.StatusCode
	if !validRedirectCode[code] {
		code = 301
	}
	rd, err := s.deps.Store.CreateRedirect(ctx, store.CreateRedirectParams{
		OrgID: p.OrgID, SourceDomain: domain, SourcePath: path, TargetURL: target, StatusCode: code,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create redirect")
		return
	}
	jobID, dispatched := s.applyRedirects(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "redirect.create", "redirect", rd.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"source_domain": domain, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"redirect": redirectView(*rd),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteRedirect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "redirectID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteRedirect(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyRedirects(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "redirect.delete", "redirect", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyRedirects renders the org's redirects and dispatches redirect.apply so
// the agent regenerates the Caddy redirects snippet.
func (s *Server) applyRedirects(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	items, err := s.deps.Store.ListRedirects(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeRedirectApply, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(items))
	for _, rd := range items {
		list = append(list, map[string]any{
			"source_domain": rd.SourceDomain, "source_path": rd.SourcePath,
			"target_url": rd.TargetURL, "status_code": rd.StatusCode,
		})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeRedirectApply, node.ID, map[string]any{"redirects": list})
	return jobID, dispatched
}
