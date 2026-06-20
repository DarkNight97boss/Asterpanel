package cloudflare

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testClient(t *testing.T, h http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return NewWithBase("tkn-123", srv.URL, srv.Client()), srv
}

func wrap(result any) string {
	b, _ := json.Marshal(map[string]any{"success": true, "errors": []any{}, "result": result})
	return string(b)
}

func TestVerifyAndZones(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tkn-123" {
			t.Errorf("missing bearer auth, got %q", got)
		}
		switch r.URL.Path {
		case "/user/tokens/verify":
			io.WriteString(w, wrap(map[string]any{"id": "tok1", "status": "active"}))
		case "/zones":
			if r.URL.Query().Get("per_page") == "" {
				t.Error("expected per_page query")
			}
			io.WriteString(w, wrap([]map[string]any{
				{"id": "z1", "name": "acme.com", "status": "active"},
				{"id": "z2", "name": "acme.io", "status": "pending"},
			}))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})

	tv, err := c.VerifyToken(context.Background())
	if err != nil || tv.Status != "active" {
		t.Fatalf("verify: %v %+v", err, tv)
	}
	zones, err := c.ListZones(context.Background())
	if err != nil || len(zones) != 2 || zones[0].Name != "acme.com" {
		t.Fatalf("zones: %v %+v", err, zones)
	}
}

func TestCreateRecordAndPurge(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/zones/z1/dns_records":
			var rec DNSRecord
			json.Unmarshal(body, &rec)
			if rec.Type != "A" || rec.Name != "www.acme.com" || rec.Content != "203.0.113.5" {
				t.Errorf("unexpected record body: %s", body)
			}
			if rec.TTL != 1 {
				t.Errorf("expected default TTL 1, got %d", rec.TTL)
			}
			rec.ID = "rec1"
			io.WriteString(w, wrap(rec))
		case r.Method == http.MethodPost && r.URL.Path == "/zones/z1/purge_cache":
			if !strings.Contains(string(body), "purge_everything") {
				t.Errorf("purge body missing purge_everything: %s", body)
			}
			io.WriteString(w, wrap(map[string]any{"id": "z1"}))
		case r.Method == http.MethodPut && r.URL.Path == "/zones/z1/dns_records/rec1":
			var rec DNSRecord
			json.Unmarshal(body, &rec)
			if rec.Content != "203.0.113.9" {
				t.Errorf("unexpected update body: %s", body)
			}
			rec.ID = "rec1"
			io.WriteString(w, wrap(rec))
		case r.Method == http.MethodDelete && r.URL.Path == "/zones/z1/dns_records/rec1":
			io.WriteString(w, wrap(map[string]any{"id": "rec1"}))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})

	rec, err := c.CreateDNSRecord(context.Background(), "z1", DNSRecord{Type: "A", Name: "www.acme.com", Content: "203.0.113.5", Proxied: true})
	if err != nil || rec.ID != "rec1" {
		t.Fatalf("create: %v %+v", err, rec)
	}
	upd, err := c.UpdateDNSRecord(context.Background(), "z1", "rec1", DNSRecord{Type: "A", Name: "www.acme.com", Content: "203.0.113.9", Proxied: false})
	if err != nil || upd.ID != "rec1" {
		t.Fatalf("update: %v %+v", err, upd)
	}
	if err := c.PurgeCache(context.Background(), "z1"); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if err := c.DeleteDNSRecord(context.Background(), "z1", "rec1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
}

func TestAPIErrorIsSurfaced(t *testing.T) {
	c, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"success":false,"errors":[{"code":9109,"message":"Invalid access token"}],"result":null}`)
	})
	if _, err := c.VerifyToken(context.Background()); err == nil || !strings.Contains(err.Error(), "Invalid access token") {
		t.Fatalf("expected surfaced API error, got %v", err)
	}
}
