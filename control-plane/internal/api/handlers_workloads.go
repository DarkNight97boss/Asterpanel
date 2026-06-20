package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// redactSensitivePayload returns a copy of a job payload with secret-bearing
// keys masked, so plaintext credentials are never persisted in the jobs table.
// The agent still receives the real values inside the signed body over mTLS.
func redactSensitivePayload(raw []byte) []byte {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return raw
	}
	for k := range m {
		lk := strings.ToLower(k)
		if lk == "secret" || lk == "token" || strings.Contains(lk, "password") ||
			strings.Contains(lk, "pem") || strings.Contains(lk, "private") {
			m[k] = "[redacted]"
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}

func websiteView(ws store.Website) map[string]any {
	var node any
	if ws.ServerNodeID.Valid {
		node = ws.ServerNodeID.UUID
	}
	return map[string]any{
		"id":              ws.ID,
		"name":            ws.Name,
		"runtime":         ws.Runtime,
		"runtime_version": ws.RuntimeVersion,
		"status":          ws.Status,
		"server_node_id":  node,
		"ssl_enabled":     ws.SSLEnabled,
		"ssl_status":      ws.SSLStatus,
		"created_at":      ws.CreatedAt,
	}
}

func (s *Server) handleListWebsites(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	sites, err := s.deps.Store.ListWebsites(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list websites")
		return
	}
	views := make([]map[string]any, 0, len(sites))
	for _, ws := range sites {
		views = append(views, websiteView(ws))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"websites": views})
}

type createWebsiteRequest struct {
	Name       string `json:"name"`
	Domain     string `json:"domain"`
	Runtime    string `json:"runtime"`
	NodeID     string `json:"node_id"`
	SSLEnabled *bool  `json:"ssl_enabled"`
}

var validWebsiteRuntimes = map[string]bool{"static": true, "node": true, "php": true, "docker": true, "proxy": true}

func (s *Server) handleCreateWebsite(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)

	var req createWebsiteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	if strings.TrimSpace(req.Name) == "" || !validWebsiteRuntimes[req.Runtime] {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "name and a valid runtime are required")
		return
	}
	if strings.TrimSpace(req.NodeID) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "node_id is required")
		return
	}
	nodeID, err := uuid.Parse(req.NodeID)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid node_id")
		return
	}
	if _, err := s.deps.Store.GetNode(ctx, p.OrgID, nodeID); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "node not found in this organization")
		return
	}

	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeWebsiteCreate, nodeID); !ok {
		org := p.OrgID
		s.audit(ctx, &org, &p.UserID, "website.create", "website", "", audit.OutcomeDenied, r, map[string]any{"reason": reason})
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	if over, used, limit := s.overQuota(ctx, p.OrgID, "sites"); over {
		httpx.ErrorWithDetails(w, http.StatusForbidden, "quota_exceeded", "plan site limit reached",
			map[string]any{"used": used, "limit": limit})
		return
	}

	ssl := true
	if req.SSLEnabled != nil {
		ssl = *req.SSLEnabled
	}

	site, err := s.deps.Store.CreateWebsite(ctx, store.CreateWebsiteParams{
		OrgID: p.OrgID, NodeID: uuid.NullUUID{UUID: nodeID, Valid: true},
		Name: req.Name, Runtime: req.Runtime, SSLEnabled: ssl,
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create website (name may already exist)")
		return
	}

	payload := map[string]any{
		"website_id": site.ID,
		"name":       site.Name,
		"domain":     req.Domain,
		"runtime":    site.Runtime,
		"ssl":        ssl,
	}
	jobID, dispatched, jerr := s.signPersistDispatch(ctx, p, jobs.TypeWebsiteCreate, nodeID, payload)
	if jerr != nil {
		s.deps.Log.Error("website job error", "error", jerr)
	}

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "website.create", "website", site.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String(), "dispatched": dispatched})
	if s.deps.Webhooks != nil {
		s.deps.Webhooks.Fire(ctx, p.OrgID, "site.created",
			map[string]any{"id": site.ID, "name": site.Name, "runtime": site.Runtime})
	}

	httpx.JSON(w, http.StatusAccepted, map[string]any{
		"website": websiteView(*site),
		"job":     map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

type renameWebsiteRequest struct {
	Name string `json:"name"`
}

// handleRenameWebsite changes a website's display name (org-scoped).
func (s *Server) handleRenameWebsite(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
		return
	}
	var req renameWebsiteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "name is required")
		return
	}
	if _, err := s.deps.Store.GetWebsite(ctx, p.OrgID, siteID); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "site not found")
		return
	}
	if err := s.deps.Store.RenameWebsite(ctx, p.OrgID, siteID, name); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not rename site")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "website.rename", "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"name": name})
	httpx.JSON(w, http.StatusOK, map[string]any{"renamed": true, "name": name})
}

type createDeploymentRequest struct {
	Ref     string `json:"ref"`
	Trigger string `json:"trigger"`
	NodeID  string `json:"node_id"`
	GitURL  string `json:"git_url"`
	Runtime string `json:"runtime"`
	Port    int    `json:"port"`
}

func (s *Server) handleCreateDeployment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)

	appID, err := uuid.Parse(chi.URLParam(r, "appID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid application id")
		return
	}
	var req createDeploymentRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	if strings.TrimSpace(req.NodeID) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "node_id is required")
		return
	}
	nodeID, err := uuid.Parse(req.NodeID)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid node_id")
		return
	}
	trigger := req.Trigger
	if trigger == "" {
		trigger = "manual"
	}

	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeAppDeploy, nodeID); !ok {
		org := p.OrgID
		s.audit(ctx, &org, &p.UserID, "deploy.create", "deployment", "", audit.OutcomeDenied, r, map[string]any{"reason": reason})
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	depID, seq, err := s.deps.Store.CreateDeployment(ctx, p.OrgID, appID, "git", req.Ref, trigger,
		uuid.NullUUID{UUID: p.UserID, Valid: true})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create deployment")
		return
	}

	runtime := req.Runtime
	if runtime == "" {
		runtime = "docker"
	}
	port := req.Port
	if port == 0 {
		port = 3000
	}
	payload := map[string]any{
		"application_id": appID,
		"deployment_id":  depID,
		"ref":            req.Ref,
		"trigger":        trigger,
		"git_url":        req.GitURL,
		"runtime":        runtime,
		"port":           port,
	}
	// Inject the application's start command + runtime env vars so the container
	// is launched with them (build-time vars are applied during the image build).
	if app, aerr := s.deps.Store.GetApplication(ctx, p.OrgID, appID); aerr == nil {
		if sc := app.StartCommand; sc != nil && strings.TrimSpace(*sc) != "" {
			payload["start_command"] = *sc
		}
		if app.RepoURL != nil && strings.TrimSpace(req.GitURL) == "" {
			payload["git_url"] = *app.RepoURL
		}
	}
	if envVars, eerr := s.deps.Store.ListAppEnvVars(ctx, p.OrgID, appID); eerr == nil {
		env := make([]map[string]any, 0, len(envVars))
		for _, e := range envVars {
			if !e.IsBuildTime {
				env = append(env, map[string]any{"key": e.Key, "value": e.Value})
			}
		}
		if len(env) > 0 {
			payload["env"] = env
		}
	}
	jobID, dispatched, jerr := s.signPersistDispatch(ctx, p, jobs.TypeAppDeploy, nodeID, payload)
	if jerr == nil && dispatched {
		_ = s.deps.Store.SetDeploymentStatus(ctx, depID, "deploying")
	}

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "deploy.create", "deployment", depID.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String(), "application_id": appID.String(), "sequence": seq})

	httpx.JSON(w, http.StatusAccepted, map[string]any{
		"deployment": map[string]any{"id": depID, "sequence": seq, "status": "queued"},
		"job":        map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

// jobPolicyAllows asks OPA (data.asterpanel.jobs) whether this job may be
// dispatched. Fails closed in production; in dev an unreachable OPA falls back to
// allow (the route already passed RBAC + the authz policy).
func (s *Server) jobPolicyAllows(ctx context.Context, p *middleware.Principal, jobType jobs.Type, nodeID uuid.UUID) (bool, string) {
	input := map[string]any{
		"job_type":  string(jobType),
		"tenant_id": p.OrgID.String(),
		"node_id":   nodeID.String(),
		"subject": map[string]any{
			"org_id":     p.OrgID.String(),
			"user_id":    p.UserID.String(),
			"superadmin": p.Superadmin,
		},
	}
	dec, err := s.deps.OPA.Evaluate(ctx, "asterpanel/jobs", input)
	if err != nil {
		if s.deps.Cfg.IsProd() {
			return false, "policy engine unavailable"
		}
		s.deps.Log.Warn("opa jobs policy unavailable; allowing (dev)", "error", err)
		return true, ""
	}
	if !dec.Allow {
		reason := "denied by job policy"
		if len(dec.Reasons) > 0 {
			reason = dec.Reasons[0]
		}
		return false, reason
	}
	return true, ""
}

// signPersistDispatch builds a job, signs it (Ed25519), persists it, and
// dispatches it to the target agent over mTLS. The job is always persisted; if
// the agent is unreachable it stays 'pending' for retry/reconciliation, so the
// API call never loses the intent.
func (s *Server) signPersistDispatch(ctx context.Context, p *middleware.Principal, typ jobs.Type, nodeID uuid.UUID, payload any) (uuid.UUID, bool, error) {
	now := time.Now()
	job, err := jobs.New(typ, nodeID, p.OrgID, payload, s.deps.Cfg.JobDefaultTTL, now)
	if err != nil {
		return uuid.Nil, false, err
	}
	body, sig, err := s.deps.Signer.Sign(job)
	if err != nil {
		return job.ID, false, err
	}
	if err := s.deps.Store.CreateJob(ctx, store.CreateJobParams{
		ID:           job.ID,
		OrgID:        uuid.NullUUID{UUID: p.OrgID, Valid: true},
		NodeID:       uuid.NullUUID{UUID: nodeID, Valid: true},
		Type:         string(typ),
		Payload:      redactSensitivePayload(job.Payload),
		Nonce:        job.Nonce,
		Signature:    sig,
		SigningKeyID: s.deps.Signer.KeyID(),
		IssuedAt:     job.IssuedAt,
		ExpiresAt:    job.ExpiresAt,
		// System-issued jobs (e.g. the health sweep) carry no user; leave NULL.
		CreatedBy: uuid.NullUUID{UUID: p.UserID, Valid: p.UserID != uuid.Nil},
	}); err != nil {
		return job.ID, false, err
	}

	if s.deps.Dispatcher == nil || !s.deps.Dispatcher.Configured() {
		s.deps.Log.Warn("dispatcher not configured; job left pending", "job_id", job.ID, "type", typ)
		return job.ID, false, nil
	}
	res, derr := s.deps.Dispatcher.Dispatch(ctx, s.deps.AgentBaseURL, body, sig)
	if derr != nil {
		s.deps.Log.Warn("job dispatch failed; job pending", "job_id", job.ID, "error", derr)
		return job.ID, false, nil
	}
	_ = s.deps.Store.MarkJobDispatched(ctx, job.ID)
	return job.ID, res.Accepted, nil
}
