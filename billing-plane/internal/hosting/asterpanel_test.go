package hosting

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// capture records the last request the module sent so tests can assert on the
// method, path, auth header and body.
type capture struct {
	method string
	path   string
	auth   string
	body   map[string]any
}

func newServer(t *testing.T, status int, respBody string, cap *capture) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.method = r.Method
		cap.path = r.URL.Path
		cap.auth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		cap.body = map[string]any{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &cap.body)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
}

func TestAsterPanelCreateAccount(t *testing.T) {
	var cap capture
	srv := newServer(t, http.StatusCreated,
		`{"account":{"id":"org-123"},"owner_email":"a@acme.example","temp_password":"astp-xyz"}`, &cap)
	defer srv.Close()

	ap := NewAsterPanel(srv.URL, "tok-secret")
	acc, err := ap.CreateAccount(context.Background(), CreateAccountRequest{
		Name: "Acme", Email: "a@acme.example", PlanCode: "pro",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if cap.method != "POST" || cap.path != "/api/v1/reseller/accounts" {
		t.Fatalf("wrong request: %s %s", cap.method, cap.path)
	}
	if cap.auth != "Bearer tok-secret" {
		t.Fatalf("missing/incorrect auth header: %q", cap.auth)
	}
	if cap.body["name"] != "Acme" || cap.body["admin_email"] != "a@acme.example" || cap.body["plan_code"] != "pro" {
		t.Fatalf("wrong body: %#v", cap.body)
	}
	if acc.ID != "org-123" || acc.Email != "a@acme.example" || acc.TempPassword != "astp-xyz" {
		t.Fatalf("wrong parsed account: %#v", acc)
	}
}

func TestAsterPanelSuspendUnsuspendAndPlan(t *testing.T) {
	var cap capture
	srv := newServer(t, http.StatusOK, `{}`, &cap)
	defer srv.Close()
	ap := NewAsterPanel(srv.URL, "tok")

	if err := ap.SuspendAccount(context.Background(), "org-9"); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if cap.path != "/api/v1/reseller/accounts/org-9/status" || cap.body["status"] != "suspended" {
		t.Fatalf("suspend wrong: %s %#v", cap.path, cap.body)
	}
	if err := ap.UnsuspendAccount(context.Background(), "org-9"); err != nil {
		t.Fatalf("unsuspend: %v", err)
	}
	if cap.body["status"] != "active" {
		t.Fatalf("unsuspend wrong: %#v", cap.body)
	}
	if err := ap.ChangePackage(context.Background(), "org-9", "scale"); err != nil {
		t.Fatalf("change package: %v", err)
	}
	if cap.path != "/api/v1/reseller/accounts/org-9/plan" || cap.body["plan_code"] != "scale" {
		t.Fatalf("change package wrong: %s %#v", cap.path, cap.body)
	}
}

func TestAsterPanelSurfacesPanelError(t *testing.T) {
	var cap capture
	srv := newServer(t, http.StatusForbidden,
		`{"error":{"code":"overselling","message":"this would allocate more sites than your plan grants"}}`, &cap)
	defer srv.Close()
	ap := NewAsterPanel(srv.URL, "tok")

	_, err := ap.CreateAccount(context.Background(), CreateAccountRequest{Name: "X", Email: "x@x.example", PlanCode: "scale"})
	if err == nil {
		t.Fatal("expected an error from a 403 response")
	}
	if got := err.Error(); !contains(got, "this would allocate more sites than your plan grants") {
		t.Fatalf("error did not surface the panel message: %q", got)
	}
}

func TestRegistry(t *testing.T) {
	r := NewRegistry()
	r.Register(NewAsterPanel("http://x", "t"))
	if _, ok := r.Get("asterpanel"); !ok {
		t.Fatal("asterpanel should be registered")
	}
	if _, ok := r.Get("cpanel"); ok {
		t.Fatal("cpanel should not be registered yet")
	}
	if names := r.Names(); len(names) != 1 || names[0] != "asterpanel" {
		t.Fatalf("unexpected names: %v", names)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
