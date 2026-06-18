package api

import (
	"context"
	"net"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func validRemoteHost(s string) bool {
	if _, _, err := net.ParseCIDR(s); err == nil {
		return true
	}
	return net.ParseIP(s) != nil
}

func (s *Server) handleListRemoteHosts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbID, err := uuid.Parse(chi.URLParam(r, "dbID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid database id")
		return
	}
	hosts, err := s.deps.Store.ListRemoteHosts(ctx, p.OrgID, dbID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list hosts")
		return
	}
	views := make([]map[string]any, 0, len(hosts))
	for _, h := range hosts {
		views = append(views, map[string]any{"id": h.ID, "host": h.Host})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"hosts": views})
}

type createRemoteHostRequest struct {
	Host string `json:"host"`
}

func (s *Server) handleCreateRemoteHost(w http.ResponseWriter, r *http.Request) {
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
	var req createRemoteHostRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	host := strings.TrimSpace(req.Host)
	if !validRemoteHost(host) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "host must be an IP address or CIDR")
		return
	}
	h, err := s.deps.Store.CreateRemoteHost(ctx, p.OrgID, dbID, host)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not add host (already allowed?)")
		return
	}
	jobID, dispatched := s.applyDbAccess(ctx, p, db)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "database.remote.add", "database_instance", dbID.String(), audit.OutcomeSuccess, r,
		map[string]any{"host": host, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"host":     map[string]any{"id": h.ID, "host": h.Host},
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteRemoteHost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbID, err := uuid.Parse(chi.URLParam(r, "dbID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid database id")
		return
	}
	hostID, err := uuid.Parse(chi.URLParam(r, "hostID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid host id")
		return
	}
	if err := s.deps.Store.DeleteRemoteHost(ctx, p.OrgID, hostID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	if db, err := s.deps.Store.GetDatabaseInstance(ctx, p.OrgID, dbID); err == nil {
		s.applyDbAccess(ctx, p, db)
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "database.remote.remove", "database_instance", dbID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyDbAccess renders the database's allowed remote hosts and dispatches
// database.access.apply to the database's node.
func (s *Server) applyDbAccess(ctx context.Context, p *middleware.Principal, db *store.DatabaseInstance) (uuid.UUID, bool) {
	if !db.ServerNodeID.Valid {
		return uuid.Nil, false
	}
	hosts, err := s.deps.Store.ListRemoteHosts(ctx, p.OrgID, db.ID)
	if err != nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeDatabaseAccess, db.ServerNodeID.UUID); !ok {
		return uuid.Nil, false
	}
	list := make([]string, 0, len(hosts))
	for _, h := range hosts {
		list = append(list, h.Host)
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeDatabaseAccess, db.ServerNodeID.UUID,
		map[string]any{"database_id": db.ID.String(), "engine": db.Engine, "hosts": list})
	return jobID, dispatched
}
