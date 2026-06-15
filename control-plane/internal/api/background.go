package api

import (
	"context"
	"time"
)

// StartBackground launches the control plane's periodic schedulers; they run
// until ctx is cancelled. Disabled when the agent dispatcher is unconfigured
// (dev without `make secrets`), since they cannot reach a node.
func (s *Server) StartBackground(ctx context.Context) {
	if s.deps.Dispatcher == nil || !s.deps.Dispatcher.Configured() {
		s.deps.Log.Info("background schedulers disabled (dispatcher not configured)")
		return
	}
	go s.healthSweepLoop(ctx)
	s.deps.Log.Info("background schedulers started", "health_sweep", "60s")
}

func (s *Server) healthSweepLoop(ctx context.Context) {
	const interval = 60 * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runHealthSweep(ctx)
		}
	}
}

// runHealthSweep probes every node-assigned site and records the result, with a
// per-site timeout so one slow node can't stall the whole sweep.
func (s *Server) runHealthSweep(ctx context.Context) {
	sites, err := s.deps.Store.ListAllSitesForHealth(ctx)
	if err != nil {
		s.deps.Log.Warn("health sweep: list sites failed", "error", err)
		return
	}
	for _, site := range sites {
		cctx, cancel := context.WithTimeout(ctx, 12*time.Second)
		if _, _, err := s.probeAndRecord(cctx, site.OrgID, site.NodeID, site.ID, site.Name, nil); err != nil {
			s.deps.Log.Debug("health sweep: probe failed", "site", site.ID, "error", err)
		}
		cancel()
	}
}
