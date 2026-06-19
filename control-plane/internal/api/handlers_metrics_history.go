package api

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// handleMetricsHistory returns the org's bucketed resource history (CPU / memory
// / disk utilisation, percent) over the requested window — the per-account graphs.
func (s *Server) handleMetricsHistory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)

	hours := 24
	if h := r.URL.Query().Get("hours"); h != "" {
		if v, err := strconv.Atoi(h); err == nil {
			hours = v
		}
	}
	if hours < 1 {
		hours = 1
	}
	if hours > 720 {
		hours = 720
	}
	// ~100 buckets across the window, floored at 5-minute resolution.
	bucketSec := hours * 3600 / 100
	if bucketSec < 300 {
		bucketSec = 300
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour)

	points, err := s.deps.Store.MetricsHistory(ctx, p.OrgID, since, bucketSec)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not load history")
		return
	}
	views := make([]map[string]any, 0, len(points))
	for _, pt := range points {
		views = append(views, map[string]any{
			"time":     pt.Time,
			"cpu_pct":  round1(pt.CPUPct),
			"mem_pct":  round1(pt.MemPct),
			"disk_pct": round1(pt.DiskPct),
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"points": views, "hours": hours})
}
