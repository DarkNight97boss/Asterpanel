package api

import (
	"net/http"
	"strings"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

// handleMailQueueList returns the Postfix mail queue (an awaited read job — the
// agent runs `postqueue -p` in the mail container and returns parsed entries).
func (s *Server) handleMailQueueList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeMailQueueList, node.ID, map[string]any{})
	if err != nil {
		fileJobError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}

type mailQueueActionRequest struct {
	Action  string `json:"action"`
	QueueID string `json:"queue_id"`
}

var validMailQueueAction = map[string]bool{"flush": true, "delete": true, "delete_all": true}

// handleMailQueueAction flushes the queue, deletes one message, or purges all —
// the agent runs the corresponding postqueue/postsuper command.
func (s *Server) handleMailQueueAction(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req mailQueueActionRequest
	if err := httpx.Decode(w, r, &req); err != nil || !validMailQueueAction[req.Action] {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "action must be flush, delete or delete_all")
		return
	}
	if req.Action == "delete" && strings.TrimSpace(req.QueueID) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "queue_id is required to delete")
		return
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeMailQueueAction, node.ID, map[string]any{
		"action":   req.Action,
		"queue_id": strings.TrimSpace(req.QueueID),
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "mail.queue."+req.Action, "mailbox", strings.TrimSpace(req.QueueID), audit.OutcomeSuccess, r,
		map[string]any{"action": req.Action})
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}
