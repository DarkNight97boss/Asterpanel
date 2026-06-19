package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

type lifecycleRequest struct {
	Action string `json:"action"`
}

var appLifecycleJob = map[string]jobs.Type{
	"start":   jobs.TypeAppStart,
	"stop":    jobs.TypeAppStop,
	"restart": jobs.TypeAppRestart,
}

// handleSiteLifecycle starts, stops or restarts a site's container by dispatching
// the matching signed app.* job to the site's node.
func (s *Server) handleSiteLifecycle(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
		return
	}
	var req lifecycleRequest
	if derr := httpx.Decode(w, r, &req); derr != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	typ, ok := appLifecycleJob[req.Action]
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "action must be start, stop or restart")
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
	if allowed, reason := s.jobPolicyAllows(ctx, p, typ, nodeID); !allowed {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, typ, nodeID, map[string]any{"website_id": siteID.String()})
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "app."+req.Action, "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"action": req.Action, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}
