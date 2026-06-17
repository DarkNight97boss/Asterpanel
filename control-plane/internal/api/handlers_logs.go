package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

const maxLogTail = 2000

// handleSiteLogs tails a site's container logs via a signed logs.tail job. The
// container name is derived from the site id (never client input), so a tenant
// can only ever read their own container's logs.
func (s *Server) handleSiteLogs(w http.ResponseWriter, r *http.Request) {
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

	tail := 200
	if t := r.URL.Query().Get("tail"); t != "" {
		if n, perr := strconv.Atoi(t); perr == nil && n > 0 {
			tail = n
		}
	}
	if tail > maxLogTail {
		tail = maxLogTail
	}

	res, err := s.runAwaitedJob(ctx, p, jobs.TypeLogsTail, site.ServerNodeID.UUID, map[string]any{
		"container": "astp_site_" + siteID.String(),
		"tail":      tail,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}

// handleSiteAnalytics computes web analytics for a site by dispatching a signed
// analytics.compute job: the agent parses the site's Caddy access log and
// returns requests, unique visitors, bandwidth, top paths and status classes.
// The site id (never client input) scopes which log is read.
func (s *Server) handleSiteAnalytics(w http.ResponseWriter, r *http.Request) {
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

	res, err := s.runAwaitedJob(ctx, p, jobs.TypeAnalyticsCompute, site.ServerNodeID.UUID, map[string]any{
		"site_id":   siteID.String(),
		"top_paths": 10,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}
