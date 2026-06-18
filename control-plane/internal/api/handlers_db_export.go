package api

import (
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

// handleDatabaseExport dumps a database (pg_dump/mysqldump) inside its container,
// gzips it and uploads it off-site to S3 — a phpMyAdmin-style export. Bounded-
// wait awaited job; returns the storage location + size.
func (s *Server) handleDatabaseExport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbID, err := uuid.Parse(chi.URLParam(r, "dbID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid database id")
		return
	}
	db, err := s.deps.Store.GetDatabaseInstance(ctx, p.OrgID, dbID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "database not found")
		return
	}
	if !db.ServerNodeID.Valid {
		httpx.Error(w, http.StatusConflict, "no_node", "database has no node")
		return
	}
	owner := db.Name
	if db.DBUser != nil && *db.DBUser != "" {
		owner = *db.DBUser
	}
	key := fmt.Sprintf("dumps/%s/%s-%d.sql.gz", p.OrgID, db.Name, time.Now().UTC().Unix())
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeDatabaseDump, db.ServerNodeID.UUID, map[string]any{
		"database_id": db.ID.String(), "engine": db.Engine, "database": db.Name, "owner": owner, "key": key,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "database.export", "database_instance", dbID.String(), audit.OutcomeSuccess, r,
		map[string]any{"engine": db.Engine})
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}
