// Package api is Aster Billing's HTTP surface. It owns clients and services and,
// when a service is created, provisions a real hosting account through the
// pluggable hosting.Backend seam — never by touching a control plane directly.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/DarkNight97boss/asterpanel/billing-plane/internal/hosting"
	"github.com/DarkNight97boss/asterpanel/billing-plane/internal/payments"
	"github.com/DarkNight97boss/asterpanel/billing-plane/internal/store"
)

type Server struct {
	store          store.Store
	backends       *hosting.Registry
	defaultBackend string
	payments       payments.Provider
}

func NewServer(st store.Store, reg *hosting.Registry, defaultBackend string) *Server {
	return &Server{store: st, backends: reg, defaultBackend: defaultBackend, payments: payments.Manual{}}
}

// Routes wires the billing API (Go 1.22+ method-aware patterns, stdlib only).
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/clients", s.listClients)
	mux.HandleFunc("POST /api/clients", s.createClient)
	mux.HandleFunc("GET /api/products", s.listProducts)
	mux.HandleFunc("POST /api/products", s.createProduct)
	mux.HandleFunc("DELETE /api/products/{id}", s.deleteProduct)
	mux.HandleFunc("GET /api/services", s.listServices)
	mux.HandleFunc("POST /api/services", s.createService)
	mux.HandleFunc("POST /api/services/{id}/suspend", s.suspendService)
	mux.HandleFunc("POST /api/services/{id}/unsuspend", s.unsuspendService)
	mux.HandleFunc("GET /api/invoices", s.listInvoices)
	mux.HandleFunc("POST /api/invoices/{id}/pay", s.payInvoice)
	mux.HandleFunc("POST /api/dunning", s.runDunning)
	mux.HandleFunc("POST /api/billing/run", s.runBilling)
	mux.HandleFunc("GET /api/tickets", s.listTickets)
	mux.HandleFunc("POST /api/tickets", s.createTicket)
	mux.HandleFunc("GET /api/tickets/{id}", s.getTicket)
	mux.HandleFunc("POST /api/tickets/{id}/reply", s.replyTicket)
	mux.HandleFunc("POST /api/tickets/{id}/status", s.ticketStatus)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func (s *Server) listClients(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"clients": s.store.ListClients()})
}

func (s *Server) createClient(w http.ResponseWriter, r *http.Request) {
	var req struct{ Name, Email string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		strings.TrimSpace(req.Name) == "" || !strings.Contains(req.Email, "@") {
		writeErr(w, http.StatusBadRequest, "invalid_request", "name and a valid email are required")
		return
	}
	c, err := s.store.CreateClient(strings.TrimSpace(req.Name), strings.ToLower(strings.TrimSpace(req.Email)))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "could not create client")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"client": c})
}

func (s *Server) listProducts(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"products": s.store.ListProducts()})
}

func (s *Server) createProduct(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string `json:"name"`
		PlanCode   string `json:"plan_code"`
		PriceCents int    `json:"price_cents"`
		Cycle      string `json:"cycle"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.PlanCode) == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "name and plan_code are required")
		return
	}
	p, err := s.store.CreateProduct(strings.TrimSpace(req.Name), strings.TrimSpace(req.PlanCode), req.PriceCents, req.Cycle)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "could not create product")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"product": p})
}

func (s *Server) deleteProduct(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteProduct(r.PathValue("id")); err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "product not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) listServices(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"services": s.store.ListServices()})
}

// createService provisions a hosting account for a client and records the bound
// service. This is the integration spine: billing intent → hosting.Backend.
func (s *Server) createService(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientID  string `json:"client_id"`
		ProductID string `json:"product_id"`
		Product   string `json:"product"`
		PlanCode  string `json:"plan_code"`
		Backend   string `json:"backend"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.ClientID) == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "client_id is required")
		return
	}
	client, err := s.store.GetClient(req.ClientID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "client not found")
		return
	}
	// When a catalog product is chosen, it drives the product name + plan_code
	// (and the recurring price the first invoice is billed at).
	productName, planCode, priceCents := strings.TrimSpace(req.Product), req.PlanCode, 0
	if req.ProductID != "" {
		prod, perr := s.store.GetProduct(req.ProductID)
		if perr != nil {
			writeErr(w, http.StatusBadRequest, "unknown_product", "product not found")
			return
		}
		productName, planCode, priceCents = prod.Name, prod.PlanCode, prod.PriceCents
	}
	backendName := req.Backend
	if backendName == "" {
		backendName = s.defaultBackend
	}
	backend, ok := s.backends.Get(backendName)
	if !ok {
		writeErr(w, http.StatusBadRequest, "unknown_backend", "no hosting backend named "+backendName)
		return
	}
	acc, err := backend.CreateAccount(r.Context(), hosting.CreateAccountRequest{
		Name: client.Name, Email: client.Email, PlanCode: planCode,
	})
	if err != nil {
		writeErr(w, http.StatusBadGateway, "provisioning_failed", "hosting backend: "+err.Error())
		return
	}
	svc, err := s.store.CreateService(store.Service{
		ClientID: client.ID, Product: productName, PlanCode: planCode,
		Backend: backendName, HostingAccountID: acc.ID, Status: "active", PriceCents: priceCents,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "provisioned but could not record service")
		return
	}
	// First invoice for the new service, billed at the product's price.
	var invoice *store.Invoice
	if priceCents > 0 {
		if inv, ierr := s.store.CreateInvoice(client.ID, svc.ID,
			[]store.InvoiceLine{{Description: productName, AmountCents: priceCents}}, 14); ierr == nil {
			invoice = &inv
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{"service": svc, "temp_password": acc.TempPassword, "invoice": invoice})
}

func (s *Server) listInvoices(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"invoices": s.store.ListInvoices()})
}

// runBilling is the recurring engine: it raises this month's invoice for every
// active, priced service not yet billed for the current period. Idempotent.
func (s *Server) runBilling(w http.ResponseWriter, _ *http.Request) {
	now := time.Now().UTC()
	billed := map[string]bool{}
	for _, inv := range s.store.ListInvoices() {
		if inv.ServiceID != "" && inv.IssuedAt.Year() == now.Year() && inv.IssuedAt.Month() == now.Month() {
			billed[inv.ServiceID] = true
		}
	}
	generated, skipped := 0, 0
	for _, svc := range s.store.ListServices() {
		if svc.Status != "active" || svc.PriceCents <= 0 {
			continue
		}
		if billed[svc.ID] {
			skipped++
			continue
		}
		if _, err := s.store.CreateInvoice(svc.ClientID, svc.ID,
			[]store.InvoiceLine{{Description: svc.Product, AmountCents: svc.PriceCents}}, 14); err == nil {
			generated++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"generated": generated, "skipped": skipped})
}

var ticketPriorities = map[string]bool{"low": true, "normal": true, "high": true}

func (s *Server) listTickets(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"tickets": s.store.ListTickets()})
}

func (s *Server) createTicket(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientID string `json:"client_id"`
		Subject  string `json:"subject"`
		Priority string `json:"priority"`
		Body     string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		strings.TrimSpace(req.Subject) == "" || strings.TrimSpace(req.Body) == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "subject and message are required")
		return
	}
	priority := strings.ToLower(strings.TrimSpace(req.Priority))
	if !ticketPriorities[priority] {
		priority = "normal"
	}
	t, err := s.store.CreateTicket(strings.TrimSpace(req.ClientID), strings.TrimSpace(req.Subject), priority, strings.TrimSpace(req.Body))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", "could not open ticket")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ticket": t})
}

func (s *Server) getTicket(w http.ResponseWriter, r *http.Request) {
	t, err := s.store.GetTicket(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "ticket not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ticket": t})
}

func (s *Server) replyTicket(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Body) == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "a message body is required")
		return
	}
	// Admin replies are staff-side.
	m, err := s.store.AddTicketMessage(r.PathValue("id"), strings.TrimSpace(req.Body), true)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "ticket not found")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"message": m})
}

func (s *Server) ticketStatus(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		(req.Status != "open" && req.Status != "pending" && req.Status != "closed") {
		writeErr(w, http.StatusBadRequest, "invalid_request", "status must be open, pending or closed")
		return
	}
	t, err := s.store.SetTicketStatus(r.PathValue("id"), req.Status)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "ticket not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ticket": t})
}

func (s *Server) payInvoice(w http.ResponseWriter, r *http.Request) {
	inv, err := s.store.GetInvoice(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "invoice not found")
		return
	}
	if inv.Status == "paid" {
		writeJSON(w, http.StatusOK, map[string]any{"invoice": inv})
		return
	}
	// Settlement goes through the gateway-agnostic PaymentProvider seam — manual
	// (offline) by default, so this works with no payment processor configured.
	ref, perr := s.payments.Charge(r.Context(), inv.ID, inv.TotalCents)
	if perr != nil {
		writeErr(w, http.StatusPaymentRequired, "payment_failed", "payment was declined")
		return
	}
	updated, _ := s.store.SetInvoiceStatus(inv.ID, "paid")
	// Dunning reversal: settling the client's last overdue invoice brings their
	// dunning-suspended services back online automatically.
	s.reactivateDunning(r.Context(), inv.ClientID)
	writeJSON(w, http.StatusOK, map[string]any{"invoice": updated, "reference": ref})
}

func (s *Server) suspendService(w http.ResponseWriter, r *http.Request) {
	s.toggleService(w, r, true)
}

func (s *Server) unsuspendService(w http.ResponseWriter, r *http.Request) {
	s.toggleService(w, r, false)
}

func (s *Server) toggleService(w http.ResponseWriter, r *http.Request, suspend bool) {
	svc, err := s.store.GetService(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "not_found", "service not found")
		return
	}
	backend, ok := s.backends.Get(svc.Backend)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "unknown_backend", "service's backend is not configured")
		return
	}
	var op error
	status, reason := "active", ""
	if suspend {
		op = backend.SuspendAccount(r.Context(), svc.HostingAccountID)
		status, reason = "suspended", "manual"
	} else {
		op = backend.UnsuspendAccount(r.Context(), svc.HostingAccountID)
	}
	if op != nil && !errors.Is(op, hosting.ErrUnsupported) {
		writeErr(w, http.StatusBadGateway, "hosting_error", "hosting backend: "+op.Error())
		return
	}
	updated, _ := s.store.SetServiceStatus(svc.ID, status, reason)
	writeJSON(w, http.StatusOK, map[string]any{"service": updated})
}

// clientHasOverdue reports whether a client has an unpaid invoice past its due date.
func (s *Server) clientHasOverdue(clientID string, now time.Time) bool {
	for _, inv := range s.store.ListInvoices() {
		if inv.ClientID == clientID && inv.Status == "open" && inv.DueAt.Before(now) {
			return true
		}
	}
	return false
}

// runDunning suspends the active services of every client with an overdue
// invoice — driving the hosting panel through the seam — and tags them 'dunning'
// so payment can reactivate exactly those.
func (s *Server) runDunning(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	suspended := 0
	for _, svc := range s.store.ListServices() {
		if svc.Status != "active" || !s.clientHasOverdue(svc.ClientID, now) {
			continue
		}
		if backend, ok := s.backends.Get(svc.Backend); ok {
			if err := backend.SuspendAccount(r.Context(), svc.HostingAccountID); err != nil && !errors.Is(err, hosting.ErrUnsupported) {
				continue
			}
		}
		s.store.SetServiceStatus(svc.ID, "suspended", "dunning")
		suspended++
	}
	writeJSON(w, http.StatusOK, map[string]any{"suspended": suspended})
}

// reactivateDunning brings a client's dunning-suspended services back online once
// the client has no overdue invoices left (manual suspensions are left alone).
func (s *Server) reactivateDunning(ctx context.Context, clientID string) {
	if s.clientHasOverdue(clientID, time.Now().UTC()) {
		return
	}
	for _, svc := range s.store.ListServices() {
		if svc.ClientID != clientID || svc.SuspendReason != "dunning" {
			continue
		}
		if backend, ok := s.backends.Get(svc.Backend); ok {
			_ = backend.UnsuspendAccount(ctx, svc.HostingAccountID)
		}
		s.store.SetServiceStatus(svc.ID, "active", "")
	}
}
