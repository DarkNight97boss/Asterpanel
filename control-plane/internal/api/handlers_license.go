package api

import (
	"net/http"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/licensing"
)

// licenseMgr returns the active entitlement manager, defaulting to Community
// when unconfigured (fail closed to free).
func (s *Server) licenseMgr() *licensing.Manager {
	if s.deps.License != nil {
		return s.deps.License
	}
	return licensing.Community()
}

// handleLicense reports the current edition + features so the UI can render
// locked/unlocked state and an upgrade prompt.
func (s *Server) handleLicense(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]any{
		"license":        s.licenseMgr().Info(),
		"known_features": licensing.KnownFeatures,
	})
}

// requireFeature gates a route behind a premium entitlement. Community (or any
// edition lacking the feature) gets 402 Payment Required with the feature name
// so the UI can show an upgrade prompt.
func (s *Server) requireFeature(feature string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !s.licenseMgr().Has(feature) {
				httpx.ErrorWithDetails(w, http.StatusPaymentRequired, "license_required",
					"this feature requires a Pro license",
					map[string]any{"feature": feature, "edition": s.licenseMgr().Edition()})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
