package api

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
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
	go s.bruteForceLoop(ctx)
	s.deps.Log.Info("background schedulers started", "health_sweep", "60s", "bruteforce_watch", "60s")
}

func (s *Server) healthSweepLoop(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
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

const (
	bruteForceWindow    = 15 * time.Minute
	bruteForceThreshold = 5
)

func (s *Server) bruteForceLoop(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runBruteForceWatch(ctx)
		}
	}
}

// hasDenyRule reports whether a deny rule already targets the given source — so
// the watch never double-bans an IP.
func hasDenyRule(rules []store.FirewallRule, ip string) bool {
	for _, r := range rules {
		if r.Action == "deny" && r.Source == ip {
			return true
		}
	}
	return false
}

// runBruteForceWatch is fail2ban-style protection: source IPs with enough failed
// logins in the window get a firewall deny rule (reusing the firewall vertical),
// applied to each org's nodes, plus an audit entry and a notification.
func (s *Server) runBruteForceWatch(ctx context.Context) {
	ips, err := s.deps.Store.RecentFailedAuthIPs(ctx, time.Now().Add(-bruteForceWindow), bruteForceThreshold)
	if err != nil {
		s.deps.Log.Warn("bruteforce watch: query failed", "error", err)
		return
	}
	if len(ips) == 0 {
		return
	}
	orgs, err := s.deps.Store.OrgIDsWithNodes(ctx)
	if err != nil || len(orgs) == 0 {
		return
	}
	for _, ipc := range ips {
		for _, org := range orgs {
			rules, _ := s.deps.Store.ListFirewallRules(ctx, org)
			if hasDenyRule(rules, ipc.IP) {
				continue
			}
			note := fmt.Sprintf("auto-ban: %d failed logins in 15m", ipc.Count)
			if _, cerr := s.deps.Store.CreateFirewallRule(ctx, org, uuid.NullUUID{}, "deny", ipc.IP, "*", &note); cerr != nil {
				continue
			}
			s.applyFirewall(ctx, &middleware.Principal{OrgID: org})

			o := org
			_ = s.deps.Audit.Append(ctx, audit.Entry{
				OrganizationID: &o, ActorType: audit.ActorSystem, Action: "security.autoban",
				ResourceType: "ip", ResourceID: ipc.IP, Outcome: audit.OutcomeSuccess,
				Metadata: map[string]any{"count": ipc.Count, "window": "15m"},
			})
			if uid, uerr := s.deps.Store.AnyOrgUserID(ctx, org); uerr == nil {
				_ = s.deps.Store.CreateNotification(ctx, store.CreateNotificationParams{
					OrgID: org, UserID: uid, Type: "security.autoban", Severity: "warning",
					Title: "Blocked " + ipc.IP, Body: note,
					ResourceType: "firewall_rule", ResourceID: ipc.IP,
				})
			}
			s.deps.Log.Info("auto-banned IP", "ip", ipc.IP, "count", ipc.Count, "org", org)
		}
	}
}
