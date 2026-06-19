package api

import (
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

// validGitBranch mirrors the agent's valid_git_ref so the hook stays safe.
func validGitBranch(s string) bool {
	if s == "" || len(s) > 100 {
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

func gitPaths(websiteID uuid.UUID) (repoPath, workTree string) {
	return "/var/asterpanel/git/" + websiteID.String() + ".git", "/var/asterpanel/sites/" + websiteID.String()
}

func gitRepoView(g store.GitRepo) map[string]any {
	return map[string]any{
		"id": g.ID, "website_id": g.WebsiteID, "branch": g.Branch,
		"clone_url": g.CloneURL, "created_at": g.CreatedAt,
	}
}

func (s *Server) handleGetGitRepo(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
		return
	}
	g, err := s.deps.Store.GetGitRepoBySite(ctx, p.OrgID, siteID)
	if err != nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"repo": nil})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"repo": gitRepoView(*g)})
}

type enableGitRepoRequest struct {
	Branch string `json:"branch"`
}

// handleEnableGitRepo provisions a bare repo + post-receive hook for a site and
// records the clone URL the user adds as a git remote.
func (s *Server) handleEnableGitRepo(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
		return
	}
	var req enableGitRepoRequest
	_ = httpx.Decode(w, r, &req)
	branch := strings.TrimSpace(req.Branch)
	if branch == "" {
		branch = "main"
	}
	if !validGitBranch(branch) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid branch name")
		return
	}
	site, err := s.deps.Store.GetWebsite(ctx, p.OrgID, siteID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "site not found")
		return
	}
	if !site.ServerNodeID.Valid {
		httpx.Error(w, http.StatusConflict, "no_node", "site has no node")
		return
	}
	nodeID := site.ServerNodeID.UUID
	host := "node"
	if n, gerr := s.deps.Store.GetNode(ctx, p.OrgID, nodeID); gerr == nil && n.Hostname != "" {
		host = n.Hostname
	}
	repoPath, workTree := gitPaths(siteID)
	cloneURL := "git@" + host + ":" + repoPath

	g, err := s.deps.Store.UpsertGitRepo(ctx, p.OrgID, siteID, branch, cloneURL)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not enable git deploy")
		return
	}
	var jobID uuid.UUID
	dispatched := false
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeGitRepoEnsure, nodeID); ok {
		jobID, dispatched, _ = s.signPersistDispatch(ctx, p, jobs.TypeGitRepoEnsure, nodeID, map[string]any{
			"repo_path": repoPath, "work_tree": workTree, "branch": branch,
		})
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "git.repo.enable", "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"branch": branch, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"repo":     gitRepoView(*g),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteGitRepo(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
		return
	}
	if err := s.deps.Store.DeleteGitRepo(ctx, p.OrgID, siteID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not disable git deploy")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "git.repo.disable", "website", siteID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
