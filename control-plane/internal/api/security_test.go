package api

import (
	"testing"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func TestHasDenyRule(t *testing.T) {
	rules := []store.FirewallRule{
		{Action: "allow", Source: "10.0.0.0/8"},
		{Action: "deny", Source: "203.0.113.66"},
	}
	if !hasDenyRule(rules, "203.0.113.66") {
		t.Fatal("expected the existing deny to be found")
	}
	if hasDenyRule(rules, "1.2.3.4") {
		t.Fatal("unexpected match for an unbanned IP")
	}
	// an allow rule for the same source must NOT count as a ban
	if hasDenyRule(rules, "10.0.0.0/8") {
		t.Fatal("allow rule must not be treated as a ban")
	}
}
