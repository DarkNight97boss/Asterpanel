package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func scheduleView(s store.BackupSchedule) map[string]any {
	return map[string]any{
		"id":             s.ID,
		"frequency":      s.Frequency,
		"retention_days": s.RetentionDays,
		"enabled":        s.Enabled,
		"last_run_at":    s.LastRunAt,
		"created_at":     s.CreatedAt,
	}
}

func (s *Server) handleListBackupSchedules(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	scheds, err := s.deps.Store.ListBackupSchedules(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list schedules")
		return
	}
	views := make([]map[string]any, 0, len(scheds))
	for _, sc := range scheds {
		views = append(views, scheduleView(sc))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"schedules": views})
}

type createScheduleRequest struct {
	Frequency     string `json:"frequency"`
	RetentionDays int    `json:"retention_days"`
}

func (s *Server) handleCreateBackupSchedule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createScheduleRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		req.Frequency = "daily"
	}
	if req.Frequency != "daily" && req.Frequency != "weekly" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "frequency must be daily or weekly")
		return
	}
	if req.RetentionDays <= 0 {
		req.RetentionDays = 30
	}
	sc, err := s.deps.Store.CreateBackupSchedule(ctx, p.OrgID, req.Frequency, req.RetentionDays)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create schedule")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "backup.schedule.create", "backup_schedule", sc.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"frequency": req.Frequency})
	httpx.JSON(w, http.StatusCreated, map[string]any{"schedule": scheduleView(*sc)})
}

func (s *Server) handleDeleteBackupSchedule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "scheduleID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteBackupSchedule(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "schedule not found")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "backup.schedule.delete", "backup_schedule", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
