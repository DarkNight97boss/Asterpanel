package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

// runtimeCatalog is the set of language versions the platform can provision per
// runtime. Runtimes with no list (static/docker/proxy) are version-less. This is
// the authoritative allowlist enforced on switch — the agent additionally
// sanitizes the version before it ever reaches an image tag.
var runtimeCatalog = map[string][]string{
	"static": {},
	"node":   {"18", "20", "22"},
	"php":    {"8.1", "8.2", "8.3", "8.4"},
	"docker": {},
	"proxy":  {},
}

func versionAllowed(runtime, version string) bool {
	for _, v := range runtimeCatalog[runtime] {
		if v == version {
			return true
		}
	}
	return false
}

func (s *Server) handleListRuntimes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	sites, err := s.deps.Store.ListWebsites(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list sites")
		return
	}
	out := make([]map[string]any, 0, len(sites))
	for _, ws := range sites {
		version := ""
		if ws.RuntimeVersion != nil {
			version = *ws.RuntimeVersion
		}
		available := runtimeCatalog[ws.Runtime]
		if available == nil {
			available = []string{}
		}
		out = append(out, map[string]any{
			"site_id":   ws.ID,
			"site":      ws.Name,
			"runtime":   ws.Runtime,
			"version":   version,
			"available": available,
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"runtimes": out})
}

type switchRuntimeRequest struct {
	Runtime string `json:"runtime"`
	Version string `json:"version"`
}

func (s *Server) handleSwitchRuntime(w http.ResponseWriter, r *http.Request) {
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

	var req switchRuntimeRequest
	if derr := httpx.Decode(w, r, &req); derr != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	// Default to the current runtime; only the version is changing in the common case.
	if req.Runtime == "" {
		req.Runtime = site.Runtime
	}
	avail, known := runtimeCatalog[req.Runtime]
	if !known {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "unknown runtime")
		return
	}

	var version *string
	if len(avail) > 0 {
		if !versionAllowed(req.Runtime, req.Version) {
			httpx.ErrorWithDetails(w, http.StatusBadRequest, "invalid_request",
				"unsupported version for this runtime", map[string]any{"available": avail})
			return
		}
		v := req.Version
		version = &v
	}

	if !site.ServerNodeID.Valid {
		httpx.Error(w, http.StatusConflict, "no_node", "site has no node assigned")
		return
	}
	nodeID := site.ServerNodeID.UUID
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeRuntimeSwitch, nodeID); !ok {
		httpx.Error(w, http.StatusForbidden, "policy_denied", "runtime switch not permitted by policy")
		return
	}

	if err := s.deps.Store.SetWebsiteRuntime(ctx, siteID, req.Runtime, version); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not update runtime")
		return
	}

	payload := map[string]any{
		"website_id": siteID.String(),
		"runtime":    req.Runtime,
		"version":    req.Version,
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeRuntimeSwitch, nodeID, payload)

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "runtime.switch", "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"runtime": req.Runtime, "version": req.Version, "job_id": jobID.String()})

	updated, _ := s.deps.Store.GetWebsite(ctx, p.OrgID, siteID)
	if updated == nil {
		updated = site
	}
	httpx.JSON(w, http.StatusAccepted, map[string]any{
		"website": websiteView(*updated),
		"job":     map[string]any{"id": jobID, "dispatched": dispatched},
	})
}
