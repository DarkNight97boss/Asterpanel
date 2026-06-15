package api

import (
	"encoding/json"
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

// handleCheckHealth runs an on-demand health probe for a site, stores the
// result and raises a notification when the site transitions into "down".
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

	res, err := s.runAwaitedJob(ctx, p, jobs.TypeHealthCheck, site.ServerNodeID.UUID, map[string]any{
		"container":  "astp_site_" + siteID.String(),
		"target_url": "", // liveness-based; HTTP target (from the site domain) is a follow-up
	})
	if err != nil {
		fileJobError(w, err)
		return
	}

	var hr healthResult
	if uerr := json.Unmarshal(res, &hr); uerr != nil || hr.Status == "" {
		httpx.Error(w, http.StatusBadGateway, "node_unavailable", "invalid health result from node")
		return
	}

	prevStatus, prevCF, _ := s.deps.Store.PrevSiteHealth(ctx, siteID)
	cf := 0
	if hr.Status == "down" {
		cf = prevCF + 1
	}
	_ = s.deps.Store.UpsertSiteHealth(ctx, siteID, hr.Status, hr.HTTPCode, hr.LatencyMS, cf)

	// Alert only on the transition into "down" — not every subsequent probe.
	if hr.Status == "down" && prevStatus != "down" {
		_ = s.deps.Store.CreateNotification(ctx, store.CreateNotificationParams{
			OrgID: p.OrgID, UserID: p.UserID, Type: "site.down", Severity: "error",
			Title: site.Name + " is down", Body: "A health check reported this site as down.",
			ResourceType: "website", ResourceID: siteID.String(),
		})
		org := p.OrgID
		s.audit(ctx, &org, &p.UserID, "site.health.down", "website", siteID.String(), audit.OutcomeFailure, r,
			map[string]any{"http_code": hr.HTTPCode})
	}

	httpx.JSON(w, http.StatusOK, map[string]any{"health": map[string]any{
		"website_id":           siteID,
		"site":                 site.Name,
		"status":               hr.Status,
		"http_code":            hr.HTTPCode,
		"latency_ms":           hr.LatencyMS,
		"consecutive_failures": cf,
	}})
}
