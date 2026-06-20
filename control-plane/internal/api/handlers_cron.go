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
)

func (s *Server) handleListCron(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	cj, err := s.deps.Store.ListCronJobs(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list cron jobs")
		return
	}
	views := make([]map[string]any, 0, len(cj))
	for _, c := range cj {
		views = append(views, map[string]any{
			"id": c.ID, "schedule": c.Schedule, "command": c.Command,
			"enabled": c.Enabled, "last_run": c.LastRunAt, "status": "ok",
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"jobs": views})
}

type createCronRequest struct {
	Schedule string `json:"schedule"`
	Command  string `json:"command"`
}

func (s *Server) handleCreateCron(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createCronRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Schedule) == "" || strings.TrimSpace(req.Command) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "schedule and command are required")
		return
	}
	job, err := s.deps.Store.CreateCronJob(ctx, p.OrgID, req.Schedule, req.Command)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create cron job")
		return
	}
	jobID, dispatched := s.applyCron(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "cron.create", "cron_job", job.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"job":      map[string]any{"id": job.ID, "schedule": job.Schedule, "command": job.Command, "enabled": job.Enabled},
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteCron(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "cronID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteCronJob(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyCron(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "cron.delete", "cron_job", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

type updateCronRequest struct {
	Schedule string `json:"schedule"`
	Command  string `json:"command"`
	Enabled  *bool  `json:"enabled"`
}

func (s *Server) handleUpdateCron(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "cronID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	var req updateCronRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Schedule) == "" || strings.TrimSpace(req.Command) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "schedule and command are required")
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	job, err := s.deps.Store.UpdateCronJob(ctx, p.OrgID, id, req.Schedule, req.Command, enabled)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "cron job not found")
		return
	}
	jobID, dispatched := s.applyCron(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "cron.update", "cron_job", job.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"job":      map[string]any{"id": job.ID, "schedule": job.Schedule, "command": job.Command, "enabled": job.Enabled},
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

// applyCron renders the org's enabled crontab and dispatches it to a node.
func (s *Server) applyCron(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	all, err := s.deps.Store.ListCronJobs(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeCronApply, node.ID); !ok {
		return uuid.Nil, false
	}
	lines := make([]map[string]any, 0, len(all))
	for _, c := range all {
		if c.Enabled {
			lines = append(lines, map[string]any{"schedule": c.Schedule, "command": c.Command})
		}
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeCronApply, node.ID, map[string]any{"jobs": lines})
	return jobID, dispatched
}
