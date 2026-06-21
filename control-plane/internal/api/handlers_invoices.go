package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func invoiceHeaderView(inv store.Invoice) map[string]any {
	return map[string]any{
		"id":             inv.ID,
		"number":         inv.Number,
		"status":         inv.Status,
		"currency":       inv.Currency,
		"period_start":   inv.PeriodStart,
		"period_end":     inv.PeriodEnd,
		"subtotal_cents": inv.SubtotalCents,
		"total_cents":    inv.TotalCents,
		"issued_at":      inv.IssuedAt,
		"due_at":         inv.DueAt,
		"paid_at":        inv.PaidAt,
	}
}

func invoiceView(inv store.Invoice) map[string]any {
	v := invoiceHeaderView(inv)
	lines := make([]map[string]any, 0, len(inv.Lines))
	for _, l := range inv.Lines {
		lines = append(lines, map[string]any{
			"description":  l.Description,
			"quantity":     l.Quantity,
			"unit_cents":   l.UnitCents,
			"amount_cents": l.AmountCents,
		})
	}
	v["lines"] = lines
	return v
}

func (s *Server) handleListInvoices(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	invs, err := s.deps.Store.ListInvoices(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list invoices")
		return
	}
	views := make([]map[string]any, 0, len(invs))
	for _, inv := range invs {
		views = append(views, invoiceHeaderView(inv))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"invoices": views})
}

func (s *Server) handleGetInvoice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "invoiceID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid invoice id")
		return
	}
	inv, err := s.deps.Store.GetInvoice(ctx, p.OrgID, id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "invoice not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"invoice": invoiceView(*inv)})
}

// billOrg generates the current-month invoice for an org from its plan (base fee
// + informational usage lines), numbered INV-YYYY-NNNN. Returns an error code
// ("" on success) so both self-billing and reseller-bills-customer can reuse it.
func (s *Server) billOrg(ctx context.Context, orgID uuid.UUID) (*store.Invoice, string) {
	plan, err := s.deps.Store.GetOrgPlan(ctx, orgID)
	if err != nil {
		return nil, "internal_error"
	}
	if plan == nil {
		return nil, "no_plan"
	}
	usage, _ := s.deps.Store.UsageCounts(ctx, orgID)

	now := time.Now().UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, -1)
	due := start.AddDate(0, 0, 14)

	// Idempotency: never bill the same org twice for one period (recurring runs).
	if billed, err := s.deps.Store.HasInvoiceForPeriod(ctx, orgID, start); err == nil && billed {
		return nil, "already_billed"
	}

	count, _ := s.deps.Store.CountOrgInvoices(ctx, orgID)
	number := fmt.Sprintf("INV-%d-%04d", now.Year(), count+1)

	lines := []store.InvoiceLine{{
		Description: fmt.Sprintf("%s plan (per %s)", plan.Name, plan.Interval),
		Quantity:    1, UnitCents: plan.PriceCents, AmountCents: plan.PriceCents,
	}}
	for _, res := range []string{"sites", "databases", "mailboxes"} {
		if n := usage[res]; n > 0 {
			lines = append(lines, store.InvoiceLine{
				Description: "Included usage — " + res, Quantity: n, UnitCents: 0, AmountCents: 0,
			})
		}
	}

	inv, err := s.deps.Store.CreateInvoice(ctx, orgID, number, plan.Currency, start, end, &due, lines)
	if err != nil {
		return nil, "create_failed"
	}
	return inv, ""
}

// billErrorStatus maps a billOrg error code to an HTTP error (returns false when
// the code is "" — success).
func billErrorStatus(w http.ResponseWriter, code string) bool {
	switch code {
	case "":
		return false
	case "no_plan":
		httpx.Error(w, http.StatusBadRequest, "no_plan", "organization has no billing plan")
	case "already_billed":
		httpx.Error(w, http.StatusConflict, "already_billed", "already billed for this period")
	case "create_failed":
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create invoice (already billed this period?)")
	default:
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not bill organization")
	}
	return true
}

// handleGenerateInvoice bills the caller's own org for the current month.
func (s *Server) handleGenerateInvoice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	inv, code := s.billOrg(ctx, p.OrgID)
	if billErrorStatus(w, code) {
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "invoice.create", "invoice", inv.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"number": inv.Number, "total_cents": inv.TotalCents})
	httpx.JSON(w, http.StatusCreated, map[string]any{"invoice": invoiceView(*inv)})
}

// handlePayInvoice settles an invoice through the payment provider (manual by
// default) and marks it paid. Idempotent for already-paid invoices.
func (s *Server) handlePayInvoice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "invoiceID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid invoice id")
		return
	}
	inv, err := s.deps.Store.GetInvoice(ctx, p.OrgID, id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "invoice not found")
		return
	}
	if inv.Status == "paid" {
		httpx.JSON(w, http.StatusOK, map[string]any{"invoice": invoiceView(*inv)})
		return
	}
	if inv.Status == "void" {
		httpx.Error(w, http.StatusConflict, "void", "cannot pay a void invoice")
		return
	}

	var provider PaymentProvider = ManualPaymentProvider{}
	ref, perr := provider.Charge(ctx, inv.ID.String(), inv.Currency, inv.TotalCents)
	if perr != nil {
		httpx.Error(w, http.StatusPaymentRequired, "payment_failed", "payment was declined")
		return
	}
	paidAt := time.Now().UTC()
	if err := s.deps.Store.SetInvoiceStatus(ctx, p.OrgID, id, "paid", &paidAt); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "invoice not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not settle invoice")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "invoice.pay", "invoice", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"reference": ref, "total_cents": inv.TotalCents})
	if s.deps.Webhooks != nil {
		s.deps.Webhooks.Fire(ctx, p.OrgID, "invoice.paid",
			map[string]any{"id": inv.ID, "number": inv.Number, "total_cents": inv.TotalCents, "currency": inv.Currency, "reference": ref})
	}
	// Dunning reversal: if this org was suspended for non-payment and now has no
	// overdue invoices left, bring it back online automatically.
	if reactivated, _ := s.deps.Store.ClearOverdueSuspension(ctx, p.OrgID); reactivated {
		s.audit(ctx, &org, &p.UserID, "billing.dunning.reactivated", "organization", p.OrgID.String(), audit.OutcomeSuccess, r, nil)
	}

	updated, _ := s.deps.Store.GetInvoice(ctx, p.OrgID, id)
	if updated == nil {
		updated = inv
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"invoice": invoiceView(*updated)})
}
