// Package migrate parses hosting-account exports (cPanel/Plesk) into a
// provider-neutral migration plan AsterPanel can act on. Parsing is pure and
// unit-tested; the control plane handles the side effects (creating domains,
// DNS, etc.) from the plan.
package migrate

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

type PlanRecord struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Content  string `json:"content"`
	TTL      int    `json:"ttl"`
	Priority *int   `json:"priority,omitempty"`
}

type PlanDomain struct {
	FQDN    string       `json:"fqdn"`
	Records []PlanRecord `json:"records"`
}

type Plan struct {
	Account   string       `json:"account"`
	Domains   []PlanDomain `json:"domains"`
	Databases []string     `json:"databases"`
	Mailboxes []string     `json:"mailboxes"`
}

func (p *Plan) Counts() (domains, databases, mailboxes int) {
	return len(p.Domains), len(p.Databases), len(p.Mailboxes)
}

var validType = map[string]bool{
	"A": true, "AAAA": true, "CNAME": true, "MX": true,
	"TXT": true, "SRV": true, "NS": true, "CAA": true,
}

// cpanelManifest is the normalized JSON an archive extractor produces from a
// cpmove account (domains + their DNS, databases, mailboxes).
type cpanelManifest struct {
	Account string `json:"account"`
	Domains []struct {
		Domain string `json:"domain"`
		DNS    []struct {
			Name     string `json:"name"`
			Type     string `json:"type"`
			Content  string `json:"content"`
			TTL      int    `json:"ttl"`
			Priority *int   `json:"priority"`
		} `json:"dns"`
	} `json:"domains"`
	Databases []string `json:"databases"`
	Mailboxes []string `json:"mailboxes"`
}

func dedupeLower(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// ParseCpanel turns a normalized cPanel account manifest into a migration plan.
func ParseCpanel(raw []byte) (*Plan, error) {
	var m cpanelManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("invalid manifest: %w", err)
	}
	plan := &Plan{
		Account:   strings.TrimSpace(m.Account),
		Databases: dedupeLower(m.Databases),
		Mailboxes: dedupeLower(m.Mailboxes),
	}
	for _, d := range m.Domains {
		fqdn := strings.ToLower(strings.TrimSpace(d.Domain))
		if fqdn == "" || !strings.Contains(fqdn, ".") {
			continue
		}
		pd := PlanDomain{FQDN: fqdn}
		for _, r := range d.DNS {
			t := strings.ToUpper(strings.TrimSpace(r.Type))
			content := strings.TrimSpace(r.Content)
			if !validType[t] || content == "" {
				continue
			}
			name := strings.TrimSpace(r.Name)
			if name == "" {
				name = "@"
			}
			ttl := r.TTL
			if ttl <= 0 {
				ttl = 3600
			}
			pd.Records = append(pd.Records, PlanRecord{
				Name: name, Type: t, Content: content, TTL: ttl, Priority: r.Priority,
			})
		}
		plan.Domains = append(plan.Domains, pd)
	}
	if len(plan.Domains) == 0 {
		return nil, errors.New("manifest has no valid domains")
	}
	return plan, nil
}
