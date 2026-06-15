package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// healthResult is the agent's health.check outcome.
type healthResult struct {
	Status    string `json:"status"`
	Running   bool   `json:"running"`
	HTTPCode  *int   `json:"http_code"`
	LatencyMS *int   `json:"latency_ms"`
}

func siteHealthView(row store.SiteHealthRow) map[string]any {
	return map[string]any{
		"website_id":           row.WebsiteID,
		"site":                 row.Name,
		"status":               row.Status,
		"http_code":            row.HTTPCode,
		"latency_ms":           row.LatencyMS,
		"consecutive_failures": row.ConsecutiveFailures,
		"checked_at":           row.CheckedAt,
	}
}

func incidentView(i store.Incident) map[string]any {
	return map[string]any{
		"id":         i.ID,
		"website_id": i.WebsiteID,
		"site":       i.Site,
		"opened_at":  i.OpenedAt,
		"closed_at":  i.ClosedAt,
		"http_code":  i.HTTPCode,
		"ongoing":    i.ClosedAt == nil,
	}
}

// dispatchAwait signs+dispatches a job (no OPA gate) and waits for its result.
// Used by system paths like the health sweep; HTTP handlers go through
// runAwaitedJob, which adds the policy check.
func (s *Server) dispatchAwait(ctx context.Context, pr *middleware.Principal, typ jobs.Type, nodeID uuid.UUID, payload map[string]any) (json.RawMessage, error) {
	jobID, dispatched, err := s.signPersistDispatch(ctx, pr, typ, nodeID, payload)
	if err != nil {
		return nil, err
	}
	if !dispatched {
		return nil, errAgentUnavailable
	}
	return s.awaitJobResult(ctx, pr.OrgID, jobID)
}

// probeAndRecord runs a health.check for a site, stores the snapshot, and
// opens/closes incidents + notifies on status transitions. userID is the
// triggering user (on-demand) or nil (background sweep). Returns the result and
// whether the site just transitioned into "down".
func (s *Server) probeAndRecord(ctx context.Context, orgID, nodeID, siteID uuid.UUID, siteName string, userID *uuid.UUID) (*healthResult, bool, error) {
	pr := &middleware.Principal{OrgID: orgID}
	if userID != nil {
		pr.UserID = *userID
	}
	res, err := s.dispatchAwait(ctx, pr, jobs.TypeHealthCheck, nodeID, map[string]any{
		"container":  "astp_site_" + siteID.String(),
		"target_url": "", // liveness-based; HTTP target (site domain) is a follow-up
	})
	if err != nil {
		return nil, false, err
	}
	var hr healthResult
	if uerr := json.Unmarshal(res, &hr); uerr != nil || hr.Status == "" {
		return nil, false, errors.New("invalid health result from node")
	}

	prevStatus, prevCF, _ := s.deps.Store.PrevSiteHealth(ctx, siteID)
	cf := 0
	if hr.Status == "down" {
		cf = prevCF + 1
	}
	_ = s.deps.Store.UpsertSiteHealth(ctx, siteID, hr.Status, hr.HTTPCode, hr.LatencyMS, cf)

	wentDown := false
	switch {
	case hr.Status == "down" && prevStatus != "down":
		if opened, _ := s.deps.Store.OpenIncidentIfNone(ctx, siteID, orgID, hr.HTTPCode); opened {
			wentDown = true
			s.notifyHealth(ctx, orgID, siteID, siteName, userID, "error",
				siteName+" is down", "A health check reported this site as down.")
		}
	case hr.Status == "up" && prevStatus == "down":
		if closed, _ := s.deps.Store.CloseOpenIncident(ctx, siteID); closed {
			s.notifyHealth(ctx, orgID, siteID, siteName, userID, "success",
				siteName+" recovered", "The site is responding again.")
		}
	}
	return &hr, wentDown, nil
}

// notifyHealth addresses a health notification to the triggering user, or to any
// org member for system-generated (sweep) events.
func (s *Server) notifyHealth(ctx context.Context, orgID, siteID uuid.UUID, _ string, userID *uuid.UUID, severity, title, body string) {
	target := uuid.Nil
	if userID != nil && *userID != uuid.Nil {
		target = *userID
	} else if uid, err := s.deps.Store.AnyOrgUserID(ctx, orgID); err == nil {
		target = uid
	}
	if target == uuid.Nil {
		return
	}
	typ := "site.down"
	if severity == "success" {
		typ = "site.recovered"
	}
	_ = s.deps.Store.CreateNotification(ctx, store.CreateNotificationParams{
		OrgID: orgID, UserID: target, Type: typ, Severity: severity,
		Title: title, Body: body, ResourceType: "website", ResourceID: siteID.String(),
	})
}

func (s *Server) handleListHealth(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	rows, err := s.deps.Store.ListSiteHealth(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list health")
		return
	}
	views := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		views = append(views, siteHealthView(row))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"sites": views})
}

// handleCheckHealth runs an on-demand health probe for a site.
func (s *Server) handleCheckHealth(w http.ResponseWriter, r *http.Request) {
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
		httpx.Error(w, http.StatusConflict, "no_node", "site has no node assigned")
		return
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeHealthCheck, site.ServerNodeID.UUID); !ok {
		httpx.Error(w, http.StatusForbidden, "policy_denied", "health check not permitted by policy")
		return
	}

	hr, wentDown, err := s.probeAndRecord(ctx, p.OrgID, site.ServerNodeID.UUID, siteID, site.Name, &p.UserID)
	if err != nil {
		fileJobError(w, err)
		return
	}
	if wentDown {
		org := p.OrgID
		s.audit(ctx, &org, &p.UserID, "site.health.down", "website", siteID.String(), audit.OutcomeFailure, r,
			map[string]any{"http_code": hr.HTTPCode})
	}
	_, cf, _ := s.deps.Store.PrevSiteHealth(ctx, siteID)
	httpx.JSON(w, http.StatusOK, map[string]any{"health": map[string]any{
		"website_id":           siteID,
		"site":                 site.Name,
		"status":               hr.Status,
		"http_code":            hr.HTTPCode,
		"latency_ms":           hr.LatencyMS,
		"consecutive_failures": cf,
	}})
}

func (s *Server) handleListIncidents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	incs, err := s.deps.Store.ListIncidents(ctx, p.OrgID, 50)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list incidents")
		return
	}
	views := make([]map[string]any, 0, len(incs))
	for _, i := range incs {
		views = append(views, incidentView(i))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"incidents": views})
}
