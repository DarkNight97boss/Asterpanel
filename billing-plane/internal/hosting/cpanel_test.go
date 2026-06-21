package hosting

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCPanelSuspendUsesWHMApi(t *testing.T) {
	var gotPath, gotQuery, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"metadata":{"result":1,"reason":"OK"}}`))
	}))
	defer srv.Close()

	cp := NewCPanel(srv.URL, "root", "TOK")
	if err := cp.SuspendAccount(context.Background(), "acme"); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if gotPath != "/json-api/suspendacct" {
		t.Fatalf("wrong WHM function path: %s", gotPath)
	}
	if gotAuth != "whm root:TOK" {
		t.Fatalf("wrong WHM auth header: %q", gotAuth)
	}
	if !contains(gotQuery, "user=acme") || !contains(gotQuery, "api.version=1") {
		t.Fatalf("missing WHM params: %s", gotQuery)
	}
}

func TestCPanelSurfacesWHMFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"metadata":{"result":0,"reason":"account not found"}}`))
	}))
	defer srv.Close()
	cp := NewCPanel(srv.URL, "root", "TOK")
	err := cp.ChangePackage(context.Background(), "ghost", "premium")
	if err == nil || !contains(err.Error(), "account not found") {
		t.Fatalf("WHM failure not surfaced: %v", err)
	}
}

func TestCPanelCreateRequiresDomain(t *testing.T) {
	cp := NewCPanel("http://x", "root", "TOK")
	if _, err := cp.CreateAccount(context.Background(), CreateAccountRequest{Email: "a@acme.example", PlanCode: "pro"}); err == nil {
		t.Fatal("create without a domain should error")
	}
}

func TestCPanelUsernameDerivation(t *testing.T) {
	if u := cpanelUsername("john.doe+test@acme.example"); u != "johndoetest" {
		t.Fatalf("username derivation: %q", u)
	}
	if u := cpanelUsername("9start@x.com"); u[0] < 'a' || u[0] > 'z' {
		t.Fatalf("username must start with a letter: %q", u)
	}
}
