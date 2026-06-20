package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

var validAppRuntimes = map[string]bool{
	"node": true, "php": true, "static": true, "docker": true,
	"python": true, "go": true, "ruby": true,
}

// validEnvKey mirrors the agent's valid_env_key: a POSIX-ish variable name so a
// crafted key can never smuggle extra `docker run` flags.
func validEnvKey(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for i, c := range s {
		switch {
		case c == '_', c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z':
		case i > 0 && c >= '0' && c <= '9':
		default:
			return false
		}
	}
	return true
}

func appStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func applicationView(a store.Application) map[string]any {
	v := map[string]any{
		"id":              a.ID,
		"name":            a.Name,
		"runtime":         a.Runtime,
		"repo_url":        appStr(a.RepoURL),
		"repo_branch":     a.RepoBranch,
		"install_command": appStr(a.InstallCommand),
		"build_command":   appStr(a.BuildCommand),
		"start_command":   appStr(a.StartCommand),
		"status":          a.Status,
		"created_at":      a.CreatedAt,
	}
	if a.WebsiteID.Valid {
		v["website_id"] = a.WebsiteID.UUID
	} else {
		v["website_id"] = nil
	}
	if a.ServerNodeID.Valid {
		v["server_node_id"] = a.ServerNodeID.UUID
	} else {
		v["server_node_id"] = nil
	}
	return v
}

func envVarView(e store.EnvVar) map[string]any {
	return map[string]any{
		"id": e.ID, "key": e.Key, "value": e.Value,
		"is_build_time": e.IsBuildTime, "created_at": e.CreatedAt,
	}
}

func (s *Server) handleListApplications(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	apps, err := s.deps.Store.ListApplications(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list applications")
		return
	}
	views := make([]map[string]any, 0, len(apps))
	for _, a := range apps {
		views = append(views, applicationView(a))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"applications": views})
}

type createApplicationRequest struct {
	Name      string `json:"name"`
	Runtime   string `json:"runtime"`
	RepoURL   string `json:"repo_url"`
	Branch    string `json:"branch"`
	NodeID    string `json:"node_id"`
	WebsiteID string `json:"website_id"`
}

func (s *Server) handleCreateApplication(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)

	var req createApplicationRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || !validAppRuntimes[req.Runtime] {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "name and a valid runtime are required")
		return
	}

	params := store.CreateApplicationParams{
		OrgID: p.OrgID, Name: req.Name, Runtime: req.Runtime, Branch: strings.TrimSpace(req.Branch),
	}
	if u := strings.TrimSpace(req.RepoURL); u != "" {
		params.RepoURL = &u
	}
	if req.NodeID != "" {
		nodeID, err := uuid.Parse(req.NodeID)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid node_id")
			return
		}
		if _, err := s.deps.Store.GetNode(ctx, p.OrgID, nodeID); err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "node not found in this organization")
			return
		}
		params.NodeID = uuid.NullUUID{UUID: nodeID, Valid: true}
	}
	if req.WebsiteID != "" {
		websiteID, err := uuid.Parse(req.WebsiteID)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid website_id")
			return
		}
		if _, err := s.deps.Store.GetWebsite(ctx, p.OrgID, websiteID); err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "website not found in this organization")
			return
		}
		params.WebsiteID = uuid.NullUUID{UUID: websiteID, Valid: true}
	}

	app, err := s.deps.Store.CreateApplicationFull(ctx, params)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create application (name may already exist)")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "application.create", "application", app.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"name": app.Name, "runtime": app.Runtime})
	httpx.JSON(w, http.StatusCreated, map[string]any{"application": applicationView(*app)})
}

func (s *Server) handleGetApplication(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	appID, err := uuid.Parse(chi.URLParam(r, "appID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid application id")
		return
	}
	app, err := s.deps.Store.GetApplication(ctx, p.OrgID, appID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "application not found")
		return
	}
	env, _ := s.deps.Store.ListAppEnvVars(ctx, p.OrgID, appID)
	envViews := make([]map[string]any, 0, len(env))
	for _, e := range env {
		envViews = append(envViews, envVarView(e))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"application": applicationView(*app), "env": envViews,
	})
}

type updateApplicationRequest struct {
	InstallCommand *string `json:"install_command"`
	BuildCommand   *string `json:"build_command"`
	StartCommand   *string `json:"start_command"`
}

// handleUpdateApplication updates the build/run command triplet. A field omitted
// from the body is left unchanged; an empty string clears it.
func (s *Server) handleUpdateApplication(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	appID, err := uuid.Parse(chi.URLParam(r, "appID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid application id")
		return
	}
	var req updateApplicationRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	app, err := s.deps.Store.UpdateApplicationConfig(ctx, p.OrgID, appID, req.InstallCommand, req.BuildCommand, req.StartCommand)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "application not found")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "application.update", "application", appID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"application": applicationView(*app)})
}

func (s *Server) handleListAppEnv(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	appID, err := uuid.Parse(chi.URLParam(r, "appID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid application id")
		return
	}
	env, err := s.deps.Store.ListAppEnvVars(ctx, p.OrgID, appID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list env vars")
		return
	}
	views := make([]map[string]any, 0, len(env))
	for _, e := range env {
		views = append(views, envVarView(e))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"env": views})
}

type setAppEnvRequest struct {
	Key         string `json:"key"`
	Value       string `json:"value"`
	IsBuildTime bool   `json:"is_build_time"`
}

func (s *Server) handleSetAppEnv(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	appID, err := uuid.Parse(chi.URLParam(r, "appID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid application id")
		return
	}
	var req setAppEnvRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	req.Key = strings.TrimSpace(req.Key)
	if !validEnvKey(req.Key) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid env var name (use A-Z, 0-9, _, not starting with a digit)")
		return
	}
	// Ensure the application belongs to this org before attaching env to it.
	if _, err := s.deps.Store.GetApplication(ctx, p.OrgID, appID); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "application not found")
		return
	}
	ev, err := s.deps.Store.UpsertAppEnvVar(ctx, p.OrgID, appID, req.Key, req.Value, req.IsBuildTime)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not set env var")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "application.env.set", "application", appID.String(), audit.OutcomeSuccess, r,
		map[string]any{"key": req.Key})
	httpx.JSON(w, http.StatusCreated, map[string]any{"env": envVarView(*ev)})
}

func (s *Server) handleDeleteAppEnv(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	appID, err := uuid.Parse(chi.URLParam(r, "appID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid application id")
		return
	}
	envID, err := uuid.Parse(chi.URLParam(r, "envID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid env var id")
		return
	}
	if err := s.deps.Store.DeleteAppEnvVar(ctx, p.OrgID, appID, envID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete env var")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "application.env.delete", "application", appID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
