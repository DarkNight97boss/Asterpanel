package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

type advisorFinding struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	Severity       string `json:"severity"` // ok | info | warning | critical
	Detail         string `json:"detail"`
	Recommendation string `json:"recommendation,omitempty"`
}

// handleSecurityAdvisor runs a read-only audit of the org's posture and returns
// findings + a posture score (cPanel "Security Advisor"). Every check is backed
// by the org's own data; nothing is mutated.
func (s *Server) handleSecurityAdvisor(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	org := p.OrgID

	var findings []advisorFinding
	add := func(id, title, sev, detail, rec string) {
		findings = append(findings, advisorFinding{ID: id, Title: title, Severity: sev, Detail: detail, Recommendation: rec})
	}

	// 1. Two-factor authentication for the current user.
	if totp, err := s.deps.Store.GetTOTP(ctx, p.UserID); err == nil && totp.Confirmed {
		add("mfa", "Two-factor authentication", "ok", "Your account has a second factor enabled.", "")
	} else {
		add("mfa", "Two-factor authentication", "warning", "Your account is protected by a password only.",
			"Enable TOTP or register a passkey for your account.")
	}

	// 2. Automated backups.
	if scheds, err := s.deps.Store.ListBackupSchedules(ctx, org); err == nil {
		if len(scheds) == 0 {
			add("backups", "Automated backups", "warning", "No backup schedule is configured.",
				"Add a daily or weekly schedule so data can be restored after an incident.")
		} else {
			add("backups", "Automated backups", "ok", fmt.Sprintf("%d backup schedule(s) configured.", len(scheds)), "")
		}
	}

	// 3. DNSSEC coverage across domains.
	if domains, err := s.deps.Store.ListDomains(ctx, org); err == nil && len(domains) > 0 {
		signed := map[string]bool{}
		if ds, e := s.deps.Store.ListDnssec(ctx, org); e == nil {
			for _, d := range ds {
				if d.Enabled {
					signed[strings.ToLower(d.Domain)] = true
				}
			}
		}
		unsigned := 0
		for _, d := range domains {
			if !signed[strings.ToLower(d.FQDN)] {
				unsigned++
			}
		}
		if unsigned > 0 {
			add("dnssec", "DNSSEC", "warning",
				fmt.Sprintf("%d of %d domain(s) are not signed with DNSSEC.", unsigned, len(domains)),
				"Enable DNSSEC and publish the DS record at your registrar.")
		} else {
			add("dnssec", "DNSSEC", "ok", "All domains are DNSSEC-signed.", "")
		}
	}

	// 4. TLS coverage across sites.
	if sites, err := s.deps.Store.ListWebsites(ctx, org); err == nil && len(sites) > 0 {
		insecure := 0
		for _, st := range sites {
			if !st.SSLEnabled || st.SSLStatus != "active" {
				insecure++
			}
		}
		if insecure > 0 {
			add("tls", "TLS certificates", "warning",
				fmt.Sprintf("%d of %d site(s) lack an active certificate.", insecure, len(sites)),
				"Issue a Let's Encrypt certificate so traffic is served over HTTPS.")
		} else {
			add("tls", "TLS certificates", "ok", "All sites serve HTTPS with an active certificate.", "")
		}
	}

	// 5. API tokens without an expiry.
	if toks, err := s.deps.Store.ListAPITokens(ctx, org); err == nil {
		longLived := 0
		for _, t := range toks {
			if t.RevokedAt == nil && t.ExpiresAt == nil {
				longLived++
			}
		}
		if longLived > 0 {
			add("tokens", "API token expiry", "warning",
				fmt.Sprintf("%d active API token(s) never expire.", longLived),
				"Set an expiry on long-lived tokens and rotate them periodically.")
		} else {
			add("tokens", "API token expiry", "ok", "All active API tokens have an expiry.", "")
		}
	}

	// 6. SSH key vs password authentication (informational).
	keys, _ := s.deps.Store.ListSSHKeys(ctx, org)
	ftp, _ := s.deps.Store.ListFtpAccounts(ctx, org)
	if len(ftp) > 0 && len(keys) == 0 {
		add("ssh", "SSH key authentication", "info",
			"Transfer accounts exist but no SSH keys are authorized — access is password-only.",
			"Add SSH public keys to enable key-based authentication.")
	} else if len(keys) > 0 {
		add("ssh", "SSH key authentication", "ok", fmt.Sprintf("%d SSH key(s) authorized.", len(keys)), "")
	}

	// 7. Firewall rules (informational — default-deny is the baseline).
	if rules, err := s.deps.Store.ListFirewallRules(ctx, org); err == nil {
		if len(rules) == 0 {
			add("firewall", "Firewall", "info", "No custom firewall rules — the default-deny baseline applies.",
				"Add explicit allow rules for the services you expose.")
		} else {
			add("firewall", "Firewall", "ok", fmt.Sprintf("%d firewall rule(s) configured.", len(rules)), "")
		}
	}

	summary := map[string]int{"ok": 0, "info": 0, "warning": 0, "critical": 0}
	for _, x := range findings {
		summary[x.Severity]++
	}
	score := 100 - summary["warning"]*15 - summary["critical"]*30
	if score < 0 {
		score = 0
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"findings": findings,
		"summary":  summary,
		"score":    score,
	})
}
