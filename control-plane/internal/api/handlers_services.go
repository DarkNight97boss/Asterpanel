package api

import (
	"net/http"
	"strings"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

// handleListServices returns the node's AsterPanel-managed containers and state
// via a bounded-wait service.control(status) job.
func (s *Server) handleListServices(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusConflict, "no_node", "no node available")
		return
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeServiceControl, node.ID, map[string]any{"action": "status"})
	if err != nil {
		fileJobError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}

type restartServiceRequest struct {
	Name string `json:"name"`
}

func (s *Server) handleRestartService(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req restartServiceRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	// Defence in depth: the agent also enforces this, but reject early.
	if !strings.HasPrefix(name, "astp_") || strings.ContainsAny(name, " \t/") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "only astp_* containers can be restarted")
		return
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusConflict, "no_node", "no node available")
		return
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeServiceControl, node.ID, map[string]any{
		"action": "restart", "name": name,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "service.restart", "node", node.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"name": name})
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}
