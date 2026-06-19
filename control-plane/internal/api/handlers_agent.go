package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

type agentJobStatusRequest struct {
	Status string          `json:"status"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

var agentJobStatuses = map[string]bool{
	"accepted": true, "running": true, "succeeded": true,
	"failed": true, "expired": true, "canceled": true,
}

// handleAgentJobStatus receives a job status update from an agent.
//
// SECURITY: in production this route is served on a dedicated listener fronted by
// mTLS (the client certificate must be the enrolled agent for the job's node).
// The dev compose terminates mTLS at the agent→control-plane hop; do not expose
// this endpoint to untrusted networks without that mutual-TLS guard.
func (s *Server) handleAgentJobStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	jobID, err := uuid.Parse(chi.URLParam(r, "jobID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid job id")
		return
	}
	var req agentJobStatusRequest
	if err := httpx.Decode(w, r, &req); err != nil || !agentJobStatuses[req.Status] {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid status payload")
		return
	}

	var errPtr *string
	if req.Error != "" {
		errPtr = &req.Error
	}
	if err := s.deps.Store.UpdateJobStatus(ctx, jobID, req.Status, []byte(req.Result), errPtr); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not update job")
		return
	}

	// Finalize a backup linked to this job from its result (size + checksum).
	if len(req.Result) > 0 {
		var res struct {
			SizeBytes int64  `json:"size_bytes"`
			SHA256    string `json:"sha256"`
		}
		_ = json.Unmarshal(req.Result, &res)
		_ = s.deps.Store.CompleteBackupForJob(ctx, jobID, req.Status, res.SizeBytes, res.SHA256)
	}

	// Finalize a staging environment whose clone/promote job just completed
	// (no-op for any job not linked to one).
	_ = s.deps.Store.SyncStagingForJob(ctx, jobID, req.Status)

	outcome := audit.OutcomeSuccess
	if req.Status == "failed" || req.Status == "expired" {
		outcome = audit.OutcomeFailure
	}
	_ = s.deps.Audit.Append(ctx, audit.Entry{
		ActorType:    audit.ActorAgent,
		Action:       "job.status",
		ResourceType: "job",
		ResourceID:   jobID.String(),
		Outcome:      outcome,
		IP:           clientIP(r),
		RequestID:    middleware.RequestIDFrom(ctx),
		Metadata:     map[string]any{"status": req.Status},
	})

	w.WriteHeader(http.StatusNoContent)
}
