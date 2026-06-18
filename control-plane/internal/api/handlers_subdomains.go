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

var validSubdomainKind = map[string]bool{"subdomain": true, "addon": true, "alias": true}

// validDocRoot accepts an absolute path with no whitespace or metacharacters,
// mirrored by the agent's renderer so the Caddy `root` directive is injection-safe.
func validDocRoot(s string) bool {
	if !strings.HasPrefix(s, "/") || len(s) > 512 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '/' || c == '.' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func subdomainView(s store.Subdomain) map[string]any {
	return map[string]any{
		"id": s.ID, "kind": s.Kind, "fqdn": s.FQDN,
		"document_root": s.DocumentRoot, "target_url": s.TargetURL, "status": s.Status,
	}
}

func (s *Server) handleListSubdomains(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListSubdomains(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list subdomains")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, sd := range items {
		views = append(views, subdomainView(sd))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"subdomains": views})
}

type createSubdomainRequest struct {
	Kind         string `json:"kind"`
	FQDN         string `json:"fqdn"`
	DocumentRoot string `json:"document_root"`
	TargetURL    string `json:"target_url"`
}

// handleCreateSubdomain creates a subdomain/addon (serving a document root) or an
// alias (redirecting to a target), then re-applies the org's Caddy snippet.
func (s *Server) handleCreateSubdomain(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createSubdomainRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	kind := strings.ToLower(strings.TrimSpace(req.Kind))
	if kind == "" {
		kind = "subdomain"
	}
	if !validSubdomainKind[kind] {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "kind must be subdomain, addon or alias")
		return
	}
	fqdn := strings.ToLower(strings.TrimSpace(req.FQDN))
	if !strings.Contains(fqdn, ".") || strings.ContainsAny(fqdn, " /") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid fully-qualified hostname is required")
		return
	}
	docRoot := strings.TrimSpace(req.DocumentRoot)
	target := strings.TrimSpace(req.TargetURL)
	if kind == "alias" {
		if !(strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://")) {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "an alias requires an absolute target URL")
			return
		}
		docRoot = ""
	} else {
		if !validDocRoot(docRoot) {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "an absolute document root is required")
			return
		}
		target = ""
	}
	sd, err := s.deps.Store.CreateSubdomain(ctx, store.CreateSubdomainParams{
		OrgID: p.OrgID, Kind: kind, FQDN: fqdn, DocumentRoot: docRoot, TargetURL: target,
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create (hostname may already exist)")
		return
	}
	jobID, dispatched := s.applySubdomains(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "subdomain.create", "subdomain", sd.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"kind": kind, "fqdn": fqdn, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"subdomain": subdomainView(*sd),
		"dispatch":  map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteSubdomain(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "subID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteSubdomain(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applySubdomains(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "subdomain.delete", "subdomain", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applySubdomains renders the org's subdomains and dispatches subdomain.apply so
// the agent regenerates the Caddy subdomains snippet.
func (s *Server) applySubdomains(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	items, err := s.deps.Store.ListSubdomains(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeSubdomainApply, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(items))
	for _, sd := range items {
		list = append(list, map[string]any{
			"kind": sd.Kind, "fqdn": sd.FQDN, "document_root": sd.DocumentRoot, "target_url": sd.TargetURL,
		})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeSubdomainApply, node.ID, map[string]any{"subdomains": list})
	return jobID, dispatched
}
