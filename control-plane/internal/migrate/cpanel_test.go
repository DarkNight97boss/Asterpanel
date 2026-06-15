package migrate

import "testing"

func TestParseCpanel(t *testing.T) {
	raw := []byte(`{
		"account": "acmeuser",
		"domains": [
			{"domain": "Acme.com", "dns": [
				{"name": "@", "type": "a", "content": "1.2.3.4", "ttl": 3600},
				{"name": "www", "type": "CNAME", "content": "acme.com.", "ttl": 0},
				{"name": "@", "type": "MX", "content": "mail.acme.com.", "ttl": 3600, "priority": 10},
				{"name": "@", "type": "BOGUS", "content": "x"},
				{"name": "@", "type": "TXT", "content": ""}
			]},
			{"domain": "no-dot", "dns": []}
		],
		"databases": ["acme_wp", "acme_wp", " "],
		"mailboxes": ["Info@acme.com", "info@acme.com"]
	}`)
	p, err := ParseCpanel(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.Domains) != 1 || p.Domains[0].FQDN != "acme.com" {
		t.Fatalf("domains = %+v", p.Domains)
	}
	// 3 valid records: bogus type and empty-content are dropped
	if len(p.Domains[0].Records) != 3 {
		t.Fatalf("records = %+v", p.Domains[0].Records)
	}
	// ttl<=0 defaulted to 3600; type upper-cased
	if p.Domains[0].Records[1].TTL != 3600 || p.Domains[0].Records[0].Type != "A" {
		t.Fatalf("normalization failed: %+v", p.Domains[0].Records)
	}
	if len(p.Databases) != 1 || len(p.Mailboxes) != 1 {
		t.Fatalf("dedupe failed: dbs=%v mboxes=%v", p.Databases, p.Mailboxes)
	}
	d, db, mb := p.Counts()
	if d != 1 || db != 1 || mb != 1 {
		t.Fatalf("counts = %d %d %d", d, db, mb)
	}
}

func TestParseCpanelRejectsEmpty(t *testing.T) {
	if _, err := ParseCpanel([]byte(`{"account":"x","domains":[]}`)); err == nil {
		t.Fatal("expected error for no valid domains")
	}
	if _, err := ParseCpanel([]byte(`not json`)); err == nil {
		t.Fatal("expected error for invalid json")
	}
}
