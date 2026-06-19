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

func stagingView(e store.StagingEnvironment) map[string]any {
	var synced any
	if e.LastSyncedAt != nil {
		synced = *e.LastSyncedAt
	}
	return map[string]any{
		"id":             e.ID,
		"website_id":     e.WebsiteID,
		"status":         e.Status,
		"last_synced_at": synced,
		"created_at":     e.CreatedAt,
	}
}

func (s *Server) handleGetStaging(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
		return
	}
	env, err := s.deps.Store.GetStagingBySite(ctx, p.OrgID, siteID)
	if err != nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"staging": nil})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"staging": stagingView(*env)})
}

// handleCreateStaging provisions (or re-clones) a site's staging environment: a
// file-level mirror of the production document root. The agent performs the copy
// asynchronously; its job callback flips the row from 'creating' to 'ready'.
func (s *Server) handleCreateStaging(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
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

	var jobID uuid.UUID
	dispatched := false
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeStagingCreate, nodeID); ok {
		jobID, dispatched, _ = s.signPersistDispatch(ctx, p, jobs.TypeStagingCreate, nodeID, map[string]any{
			"website_id": siteID.String(),
		})
	}
	env, err := s.deps.Store.UpsertStagingEnvironment(ctx, p.OrgID, siteID, uuid.NullUUID{UUID: jobID, Valid: dispatched})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create staging environment")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "staging.create", "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"staging":  stagingView(*env),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

// handlePromoteStaging copies the staging tree back over production (the agent
// snapshots production first so it can be rolled back). Only a 'ready'
// environment can be promoted.
func (s *Server) handlePromoteStaging(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
		return
	}
	env, err := s.deps.Store.GetStagingBySite(ctx, p.OrgID, siteID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "no staging environment")
		return
	}
	if env.Status != "ready" {
		httpx.Error(w, http.StatusConflict, "not_ready", "staging environment is not ready to promote")
		return
	}
	site, err := s.deps.Store.GetWebsite(ctx, p.OrgID, siteID)
	if err != nil || !site.ServerNodeID.Valid {
		httpx.Error(w, http.StatusConflict, "no_node", "site has no node")
		return
	}
	nodeID := site.ServerNodeID.UUID

	var jobID uuid.UUID
	dispatched := false
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeStagingPromote, nodeID); ok {
		jobID, dispatched, _ = s.signPersistDispatch(ctx, p, jobs.TypeStagingPromote, nodeID, map[string]any{
			"website_id": siteID.String(),
		})
	}
	updated, err := s.deps.Store.SetStagingJob(ctx, p.OrgID, siteID, "promoting", uuid.NullUUID{UUID: jobID, Valid: dispatched})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not promote staging environment")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "staging.promote", "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"staging":  stagingView(*updated),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteStaging(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
		return
	}
	// Best-effort: tell the node to remove the staging tree before forgetting it.
	if site, gerr := s.deps.Store.GetWebsite(ctx, p.OrgID, siteID); gerr == nil && site.ServerNodeID.Valid {
		nodeID := site.ServerNodeID.UUID
		if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeStagingDestroy, nodeID); ok {
			_, _, _ = s.signPersistDispatch(ctx, p, jobs.TypeStagingDestroy, nodeID, map[string]any{
				"website_id": siteID.String(),
			})
		}
	}
	if err := s.deps.Store.DeleteStaging(ctx, p.OrgID, siteID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete staging environment")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "staging.destroy", "website", siteID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
