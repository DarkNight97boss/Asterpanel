package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// automation is the unattended billing cron — WHMCS's daily automation. When
// enabled, the scheduler runs the billing + dunning sweeps every interval.
type automation struct {
	mu              sync.Mutex
	enabled         bool
	intervalSeconds int
	lastBilling     time.Time
	lastDunning     time.Time
	lastGenerated   int
	lastSuspended   int
}

// StartScheduler launches the background cron. It checks once a second and runs
// a cycle when enabled and at least intervalSeconds have elapsed since the last
// one, so live config changes take effect promptly. The sweeps are idempotent
// (period-deduped billing; reason-tagged dunning), so an at-startup run is safe.
// Stops when ctx is cancelled.
func (s *Server) StartScheduler(ctx context.Context) {
	go func() {
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		var lastRun time.Time
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tick.C:
				s.auto.mu.Lock()
				enabled, iv := s.auto.enabled, s.auto.intervalSeconds
				s.auto.mu.Unlock()
				if !enabled || iv < 1 || now.Sub(lastRun) < time.Duration(iv)*time.Second {
					continue
				}
				lastRun = now
				s.runAutomationCycle(ctx)
			}
		}
	}()
}

// runAutomationCycle runs both sweeps and records the outcome.
func (s *Server) runAutomationCycle(ctx context.Context) (generated, suspended int) {
	generated, _ = s.billingSweep()
	suspended = s.dunningSweep(ctx)
	now := time.Now().UTC()
	s.auto.mu.Lock()
	s.auto.lastBilling, s.auto.lastDunning = now, now
	s.auto.lastGenerated, s.auto.lastSuspended = generated, suspended
	s.auto.mu.Unlock()
	return generated, suspended
}

func (s *Server) automationView() map[string]any {
	s.auto.mu.Lock()
	defer s.auto.mu.Unlock()
	v := map[string]any{
		"enabled":          s.auto.enabled,
		"interval_seconds": s.auto.intervalSeconds,
		"last_generated":   s.auto.lastGenerated,
		"last_suspended":   s.auto.lastSuspended,
		"last_billing_run": nil,
		"last_dunning_run": nil,
	}
	if !s.auto.lastBilling.IsZero() {
		v["last_billing_run"] = s.auto.lastBilling
	}
	if !s.auto.lastDunning.IsZero() {
		v["last_dunning_run"] = s.auto.lastDunning
	}
	return v
}

func (s *Server) getAutomation(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"automation": s.automationView()})
}

func (s *Server) setAutomation(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled         *bool `json:"enabled"`
		IntervalSeconds *int  `json:"interval_seconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", "invalid body")
		return
	}
	s.auto.mu.Lock()
	if req.Enabled != nil {
		s.auto.enabled = *req.Enabled
	}
	if req.IntervalSeconds != nil && *req.IntervalSeconds >= 1 {
		s.auto.intervalSeconds = *req.IntervalSeconds
	}
	s.auto.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"automation": s.automationView()})
}

// runAutomationNow triggers a cycle immediately (the admin "run now" button).
func (s *Server) runAutomationNow(w http.ResponseWriter, r *http.Request) {
	generated, suspended := s.runAutomationCycle(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"generated": generated, "suspended": suspended, "automation": s.automationView()})
}
