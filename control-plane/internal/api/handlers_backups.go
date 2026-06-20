package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

var validBackupTypes = map[string]bool{"full": true, "files": true, "database": true, "volume": true}

func backupView(b store.Backup) map[string]any {
	return map[string]any{
		"id":              b.ID,
		"type":            b.Type,
		"trigger":         b.Trigger,
		"status":          b.Status,
		"storage_backend": b.StorageBackend,
		"size_bytes":      b.SizeBytes,
		"checksum":        b.Checksum,
		"created_at":      b.CreatedAt,
	}
}

func (s *Server) handleListBackups(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	backups, err := s.deps.Store.ListBackups(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list backups")
		return
	}
	views := make([]map[string]any, 0, len(backups))
	for _, b := range backups {
		views = append(views, backupView(b))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"backups": views})
}

type createBackupRequest struct {
	Type       string `json:"type"`
	TargetPath string `json:"target_path"`
}

func (s *Server) handleCreateBackup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createBackupRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		req.Type = "full"
	}
	if !validBackupTypes[req.Type] {
		req.Type = "full"
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeBackupCreate, node.ID); !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	b, err := s.deps.Store.CreateBackup(ctx, p.OrgID, uuid.NullUUID{}, req.Type, "manual", "s3")
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create backup")
		return
	}

	target := req.TargetPath
	if target == "" {
		target = "/var/asterpanel/sites"
	}
	payload := map[string]any{"backup_id": b.ID, "type": req.Type, "target_path": target}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeBackupCreate, node.ID, payload)
	_ = s.deps.Store.SetBackupJob(ctx, b.ID, jobID)

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "backup.create", "backup", b.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"type": req.Type, "job_id": jobID.String()})

	httpx.JSON(w, http.StatusAccepted, map[string]any{
		"backup": backupView(*b),
		"job":    map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	backupID, err := uuid.Parse(chi.URLParam(r, "backupID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid backup id")
		return
	}
	b, err := s.deps.Store.GetBackup(ctx, p.OrgID, backupID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "backup not found")
		return
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeBackupRestore, node.ID); !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	restoreID, err := s.deps.Store.CreateRestoreJob(ctx, p.OrgID, backupID, uuid.NullUUID{})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create restore job")
		return
	}

	checksum := ""
	if b.Checksum != nil {
		checksum = *b.Checksum
	}
	payload := map[string]any{
		"backup_id":      backupID,
		"restore_job_id": restoreID,
		"type":           b.Type,
		"target_path":    "/var/asterpanel/sites",
		"checksum":       checksum,        // agent verifies before extracting
		"storage":        b.StorageBackend, // s3 → fetched off-site if the local copy is gone
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeBackupRestore, node.ID, payload)

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "backup.restore", "backup", backupID.String(), audit.OutcomeSuccess, r,
		map[string]any{"restore_job_id": restoreID.String(), "job_id": jobID.String()})

	httpx.JSON(w, http.StatusAccepted, map[string]any{
		"restore": map[string]any{"id": restoreID, "status": "pending"},
		"job":     map[string]any{"id": jobID, "dispatched": dispatched},
	})
}
