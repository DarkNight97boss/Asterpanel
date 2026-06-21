package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DarkNight97boss/asterpanel/billing-plane/internal/hosting"
	"github.com/DarkNight97boss/asterpanel/billing-plane/internal/store"
)

// fakeBackend records what the billing API asks the hosting seam to do.
type fakeBackend struct {
	created    hosting.CreateAccountRequest
	suspended  string
	unsuspend  string
	failCreate bool
}

func (f *fakeBackend) Name() string                            { return "fake" }
func (f *fakeBackend) TestConnection(context.Context) error    { return nil }
func (f *fakeBackend) CreateAccount(_ context.Context, req hosting.CreateAccountRequest) (*hosting.Account, error) {
	if f.failCreate {
		return nil, hosting.ErrUnsupported
	}
	f.created = req
	return &hosting.Account{ID: "acct-1", Email: req.Email, TempPassword: "pw-once"}, nil
}
func (f *fakeBackend) SuspendAccount(_ context.Context, id string) error   { f.suspended = id; return nil }
func (f *fakeBackend) UnsuspendAccount(_ context.Context, id string) error { f.unsuspend = id; return nil }
func (f *fakeBackend) ChangePackage(context.Context, string, string) error { return nil }

func newTestServer(fb *fakeBackend) http.Handler {
	reg := hosting.NewRegistry()
	reg.Register(fb)
	return NewServer(store.NewMemory(), reg, "fake").Routes()
}

func do(t *testing.T, h http.Handler, method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func TestCreateServiceProvisionsViaBackend(t *testing.T) {
	fb := &fakeBackend{}
	h := newTestServer(fb)

	_, cres := do(t, h, "POST", "/api/clients", `{"name":"Acme","email":"a@acme.example"}`)
	clientID := cres["client"].(map[string]any)["id"].(string)

	rec, sres := do(t, h, "POST", "/api/services",
		`{"client_id":"`+clientID+`","product":"Pro hosting","plan_code":"pro"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create service status = %d, body %s", rec.Code, rec.Body)
	}
	// The billing API must have driven the hosting seam with the client's identity.
	if fb.created.Name != "Acme" || fb.created.Email != "a@acme.example" || fb.created.PlanCode != "pro" {
		t.Fatalf("backend not provisioned correctly: %#v", fb.created)
	}
	svc := sres["service"].(map[string]any)
	if svc["hosting_account_id"] != "acct-1" || svc["status"] != "active" || svc["backend"] != "fake" {
		t.Fatalf("service not bound to the provisioned account: %#v", svc)
	}
	if sres["temp_password"] != "pw-once" {
		t.Fatalf("one-time password not returned: %#v", sres["temp_password"])
	}
}

func TestSuspendServiceDrivesBackend(t *testing.T) {
	fb := &fakeBackend{}
	h := newTestServer(fb)
	_, cres := do(t, h, "POST", "/api/clients", `{"name":"Acme","email":"a@acme.example"}`)
	clientID := cres["client"].(map[string]any)["id"].(string)
	_, sres := do(t, h, "POST", "/api/services", `{"client_id":"`+clientID+`","plan_code":"pro"}`)
	svcID := sres["service"].(map[string]any)["id"].(string)

	rec, out := do(t, h, "POST", "/api/services/"+svcID+"/suspend", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("suspend status = %d", rec.Code)
	}
	if fb.suspended != "acct-1" {
		t.Fatalf("backend SuspendAccount not called with the hosting account id, got %q", fb.suspended)
	}
	if out["service"].(map[string]any)["status"] != "suspended" {
		t.Fatalf("service status not updated: %#v", out["service"])
	}

	do(t, h, "POST", "/api/services/"+svcID+"/unsuspend", "")
	if fb.unsuspend != "acct-1" {
		t.Fatalf("backend UnsuspendAccount not called, got %q", fb.unsuspend)
	}
}

func TestCreateServiceFromCatalogProduct(t *testing.T) {
	fb := &fakeBackend{}
	h := newTestServer(fb)

	_, cres := do(t, h, "POST", "/api/clients", `{"name":"Acme","email":"a@acme.example"}`)
	clientID := cres["client"].(map[string]any)["id"].(string)
	_, pres := do(t, h, "POST", "/api/products",
		`{"name":"Business","plan_code":"scale","price_cents":9900,"cycle":"monthly"}`)
	productID := pres["product"].(map[string]any)["id"].(string)

	// Ordering by product_id must drive the plan_code + product name from the catalog.
	rec, sres := do(t, h, "POST", "/api/services",
		`{"client_id":"`+clientID+`","product_id":"`+productID+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create service status = %d, body %s", rec.Code, rec.Body)
	}
	if fb.created.PlanCode != "scale" {
		t.Fatalf("product plan_code not used for provisioning: %q", fb.created.PlanCode)
	}
	if sres["service"].(map[string]any)["product"] != "Business" {
		t.Fatalf("product name not carried onto the service: %#v", sres["service"])
	}
}

func TestOrderingAProductInvoicesAndPays(t *testing.T) {
	h := newTestServer(&fakeBackend{})
	_, cres := do(t, h, "POST", "/api/clients", `{"name":"Acme","email":"a@acme.example"}`)
	clientID := cres["client"].(map[string]any)["id"].(string)
	_, pres := do(t, h, "POST", "/api/products", `{"name":"Pro","plan_code":"pro","price_cents":2900}`)
	productID := pres["product"].(map[string]any)["id"].(string)

	// Ordering a paid product must raise a first invoice for its price.
	_, sres := do(t, h, "POST", "/api/services", `{"client_id":"`+clientID+`","product_id":"`+productID+`"}`)
	inv := sres["invoice"].(map[string]any)
	if inv == nil || inv["total_cents"].(float64) != 2900 || inv["status"] != "open" {
		t.Fatalf("first invoice not raised at product price: %#v", inv)
	}
	invID := inv["id"].(string)

	rec, payRes := do(t, h, "POST", "/api/invoices/"+invID+"/pay", "")
	if rec.Code != http.StatusOK || payRes["invoice"].(map[string]any)["status"] != "paid" {
		t.Fatalf("pay did not settle the invoice: %d %#v", rec.Code, payRes)
	}
	if ref, _ := payRes["reference"].(string); ref == "" {
		t.Fatalf("manual payment reference missing")
	}
}

func TestDunningSuspendsThenPaymentReactivates(t *testing.T) {
	fb := &fakeBackend{}
	reg := hosting.NewRegistry()
	reg.Register(fb)
	st := store.NewMemory()
	srv := NewServer(st, reg, "fake")
	h := srv.Routes()

	c, _ := st.CreateClient("Acme", "a@acme.example")
	svc, _ := st.CreateService(store.Service{ClientID: c.ID, Backend: "fake", HostingAccountID: "acct-9", Status: "active"})
	// An invoice already past due.
	inv, _ := st.CreateInvoice(c.ID, svc.ID, []store.InvoiceLine{{Description: "Pro", AmountCents: 2900}}, -5)

	// Dunning must suspend the client's service via the hosting seam.
	if rec, out := do(t, h, "POST", "/api/dunning", ""); rec.Code != http.StatusOK || out["suspended"].(float64) != 1 {
		t.Fatalf("dunning did not suspend: %d %#v", rec.Code, out)
	}
	if fb.suspended != "acct-9" {
		t.Fatalf("hosting backend not driven to suspend: %q", fb.suspended)
	}
	if got, _ := st.GetService(svc.ID); got.Status != "suspended" || got.SuspendReason != "dunning" {
		t.Fatalf("service not marked dunning-suspended: %#v", got)
	}

	// Paying the overdue invoice must reactivate the dunning-suspended service.
	do(t, h, "POST", "/api/invoices/"+inv.ID+"/pay", "")
	if fb.unsuspend != "acct-9" {
		t.Fatalf("hosting backend not driven to unsuspend on payment: %q", fb.unsuspend)
	}
	if got, _ := st.GetService(svc.ID); got.Status != "active" || got.SuspendReason != "" {
		t.Fatalf("service not reactivated after payment: %#v", got)
	}
}

func TestRecurringBillingIsIdempotentPerPeriod(t *testing.T) {
	h := newTestServer(&fakeBackend{})
	_, cres := do(t, h, "POST", "/api/clients", `{"name":"Acme","email":"a@acme.example"}`)
	clientID := cres["client"].(map[string]any)["id"].(string)
	_, pres := do(t, h, "POST", "/api/products", `{"name":"Pro","plan_code":"pro","price_cents":2900}`)
	productID := pres["product"].(map[string]any)["id"].(string)
	// Provisioning already raised this period's first invoice for the service.
	do(t, h, "POST", "/api/services", `{"client_id":"`+clientID+`","product_id":"`+productID+`"}`)

	// A billing run this same period must NOT double-bill the service.
	if _, out := do(t, h, "POST", "/api/billing/run", ""); out["generated"].(float64) != 0 || out["skipped"].(float64) != 1 {
		t.Fatalf("recurring run should skip the already-billed service: %#v", out)
	}
}

func TestCreateServiceRejectsUnknownClientAndBackend(t *testing.T) {
	h := newTestServer(&fakeBackend{})
	if rec, _ := do(t, h, "POST", "/api/services", `{"client_id":"nope","plan_code":"pro"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown client should 404, got %d", rec.Code)
	}
	_, cres := do(t, h, "POST", "/api/clients", `{"name":"Acme","email":"a@acme.example"}`)
	clientID := cres["client"].(map[string]any)["id"].(string)
	if rec, _ := do(t, h, "POST", "/api/services",
		`{"client_id":"`+clientID+`","backend":"plesk","plan_code":"pro"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown backend should 400, got %d", rec.Code)
	}
}
