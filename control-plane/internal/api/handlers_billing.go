package api

import (
	"net/http"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

// handleBilling returns the org's plan, its limits, and current usage so the UI
// can render quota bars. Quota enforcement happens on each create endpoint.
func (s *Server) handleBilling(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)

	code, limits, err := s.deps.Store.GetOrgPlanLimits(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not load plan")
		return
	}
	usage, err := s.deps.Store.UsageCounts(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not load usage")
		return
	}
	if limits == nil {
		limits = map[string]int{}
	}
	plan := code
	if plan == "" {
		plan = "none"
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"plan":   plan,
		"limits": limits,
		"usage":  usage,
	})
}
