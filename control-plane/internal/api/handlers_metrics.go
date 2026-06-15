package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

const (
	bytesPerMB = 1 << 20
	bytesPerGB = 1 << 30
)

type agentMetricsRequest struct {
	CPUPct      float64 `json:"cpu_pct"`
	MemUsedMB   int64   `json:"mem_used_mb"`
	MemTotalMB  int64   `json:"mem_total_mb"`
	DiskUsedGB  int64   `json:"disk_used_gb"`
	DiskTotalGB int64   `json:"disk_total_gb"`
	Load1       float64 `json:"load1"`
	Containers  int     `json:"containers"`
}

// handleAgentMetrics ingests a metrics sample pushed by an agent.
//
// SECURITY: like the job-status callback, this internal route is served behind
// mTLS in production (the client certificate must be the enrolled agent for the
// node); do not expose it to untrusted networks without that guard.
func (s *Server) handleAgentMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	nodeID, err := uuid.Parse(chi.URLParam(r, "nodeID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid node id")
		return
	}
	var req agentMetricsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid metrics payload")
		return
	}
	// Clamp CPU to a sane range; the rest are non-negative counters. The agent
	// reports memory in MB and disk in GB; the time series stores bytes.
	cpu := req.CPUPct
	if cpu < 0 {
		cpu = 0
	} else if cpu > 100 {
		cpu = 100
	}
	if err := s.deps.Store.InsertNodeMetrics(ctx, nodeID, cpu,
		req.MemUsedMB*bytesPerMB, req.MemTotalMB*bytesPerMB,
		req.DiskUsedGB*bytesPerGB, req.DiskTotalGB*bytesPerGB,
		req.Load1, req.Containers); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store metrics")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleMetrics returns the org's aggregated fleet metrics for the panel.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	fm, err := s.deps.Store.FleetMetrics(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not load metrics")
		return
	}
	series := fm.CPUSeries
	if series == nil {
		series = []float64{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"metrics": map[string]any{
			"cpu_pct":       fm.CPUPct,
			"mem_used_mb":   fm.MemUsedMB,
			"mem_total_mb":  fm.MemTotalMB,
			"disk_used_gb":  fm.DiskUsedGB,
			"disk_total_gb": fm.DiskTotalGB,
			"cpu_series":    series,
			// Traffic metrics need reverse-proxy integration; not yet collected.
			"bandwidth_gb_month": 0,
			"requests_24h":       0,
		},
	})
}
