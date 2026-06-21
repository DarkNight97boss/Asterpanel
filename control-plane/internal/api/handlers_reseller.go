package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// slugify turns a display name into a URL-safe org slug fragment.
func slugify(name string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevDash = false
		case !prevDash:
			b.WriteByte('-')
			prevDash = true
		}
	}
	s := strings.Trim(b.String(), "-")
	if s == "" {
		s = "org"
	}
	return s
}

func subAccountView(a store.SubAccount) map[string]any {
	var ownerID any
	if a.OwnerUserID.Valid {
		ownerID = a.OwnerUserID.UUID
	}
	return map[string]any{
		"id":            a.ID,
		"name":          a.Name,
		"slug":          a.Slug,
		"status":        a.Status,
		"plan_code":     a.PlanCode,
		"sites":         a.Sites,
		"created_at":    a.CreatedAt,
		"owner_user_id": ownerID,
		"owner_email":   a.OwnerEmail,
	}
}

// planLimitsByCode resolves a plan code to its limit map (an empty code → nil,
// i.e. an "unlimited" assignment).
func (s *Server) planLimitsByCode(ctx context.Context, code string) (map[string]int, error) {
	if strings.TrimSpace(code) == "" {
		return nil, nil
	}
	id, err := s.deps.Store.GetPlanIDByCode(ctx, code)
	if err != nil {
		return nil, err
	}
	plan, err := s.deps.Store.GetPlan(ctx, id)
	if err != nil {
		return nil, err
	}
	return plan.Limits, nil
}

// overAllocates is the overselling guard. It reports whether assigning newLimits
// to one of parentOrgID's direct sub-accounts (excluding `except`, the account
// being re-planned, if set) would let the reseller hand out more capacity than
// its OWN plan grants. A reseller with no plan (unlimited) is never constrained.
// Granting an unlimited child (newLimits missing/≤0 for a resource the parent
// caps) is itself overselling — you can't sell unlimited capacity from a finite
// budget — and is reported with allocated == -1.
func (s *Server) overAllocates(ctx context.Context, parentOrgID uuid.UUID, except uuid.NullUUID, newLimits map[string]int) (over bool, resource string, allocated, limit int) {
	_, parentLimits, err := s.deps.Store.GetOrgPlanLimits(ctx, parentOrgID)
	if err != nil || len(parentLimits) == 0 {
		return false, "", 0, 0
	}
	siblings, err := s.deps.Store.SumSubAccountPlanLimits(ctx, parentOrgID, except)
	if err != nil {
		return false, "", 0, 0
	}
	for key, lim := range parentLimits {
		if lim <= 0 {
			continue // unlimited for the reseller on this resource
		}
		res := strings.TrimPrefix(key, "max_")
		nv := newLimits[key]
		if nv <= 0 {
			return true, res, -1, lim // would grant unlimited from a finite budget
		}
		if siblings[key]+nv > lim {
			return true, res, siblings[key] + nv, lim
		}
	}
	return false, "", 0, 0
}

// rejectOverselling writes the standard 403 when the guard trips; returns true
// if it rejected (so the caller can stop).
func rejectOverselling(w http.ResponseWriter, over bool, resource string, allocated, limit int) bool {
	if !over {
		return false
	}
	if allocated < 0 {
		httpx.ErrorWithDetails(w, http.StatusForbidden, "overselling",
			"cannot grant an unlimited "+resource+" allowance from your limited plan",
			map[string]any{"resource": resource, "limit": limit})
		return true
	}
	httpx.ErrorWithDetails(w, http.StatusForbidden, "overselling",
		"this would allocate more "+resource+" than your plan grants",
		map[string]any{"resource": resource, "allocated": allocated, "limit": limit})
	return true
}

func (s *Server) handleListSubAccounts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	accounts, err := s.deps.Store.ListSubAccounts(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list sub-accounts")
		return
	}
	views := make([]map[string]any, 0, len(accounts))
	for _, a := range accounts {
		views = append(views, subAccountView(a))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"accounts": views})
}

type createSubAccountRequest struct {
	Name       string `json:"name"`
	AdminEmail string `json:"admin_email"`
	PlanCode   string `json:"plan_code"`
}

// handleCreateSubAccount provisions a child org + its owner user, returning a
// one-time temporary password the reseller hands to their customer.
func (s *Server) handleCreateSubAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)

	var req createSubAccountRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	email := strings.ToLower(strings.TrimSpace(req.AdminEmail))
	if name == "" || !strings.Contains(email, "@") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "name and a valid admin_email are required")
		return
	}

	var planID uuid.NullUUID
	if req.PlanCode != "" {
		id, err := s.deps.Store.GetPlanIDByCode(ctx, req.PlanCode)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "unknown plan code")
			return
		}
		planID = uuid.NullUUID{UUID: id, Valid: true}
	}

	// Overselling guard: a reseller can't allocate a new sub-account more than
	// its own plan grants (counting what its existing sub-accounts already hold).
	newLimits, lerr := s.planLimitsByCode(ctx, req.PlanCode)
	if lerr != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "unknown plan code")
		return
	}
	if over, res, alloc, lim := s.overAllocates(ctx, p.OrgID, uuid.NullUUID{}, newLimits); rejectOverselling(w, over, res, alloc, lim) {
		return
	}

	// Sub-account count limit: a reseller's plan may cap how many customers it
	// can have (max_accounts). No plan / no cap means unlimited.
	if _, plimits, perr := s.deps.Store.GetOrgPlanLimits(ctx, p.OrgID); perr == nil && plimits["max_accounts"] > 0 {
		if n, cerr := s.deps.Store.CountSubAccounts(ctx, p.OrgID); cerr == nil && n >= plimits["max_accounts"] {
			httpx.ErrorWithDetails(w, http.StatusForbidden, "account_limit",
				"your plan's sub-account limit is reached", map[string]any{"used": n, "limit": plimits["max_accounts"]})
			return
		}
	}

	ownerRole, err := s.deps.Store.GetSystemRoleID(ctx, "owner")
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "owner role missing")
		return
	}
	tempPassword, err := crypto.RandomTokenURL(12)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate password")
		return
	}
	hash, err := crypto.HashPassword(tempPassword)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not hash password")
		return
	}
	suffix, _ := crypto.RandomHex(3)

	org, _, err := s.deps.Store.ProvisionSubAccount(ctx, store.ProvisionSubAccountParams{
		Name: name, Slug: slugify(name) + "-" + suffix, ParentOrgID: p.OrgID, PlanID: planID,
		OwnerEmail: email, OwnerFullName: name + " Admin", OwnerPasswordHash: hash, OwnerRoleID: ownerRole,
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create sub-account (email already in use?)")
		return
	}
	_ = s.deps.Store.MarkReseller(ctx, p.OrgID)

	org2 := p.OrgID
	s.audit(ctx, &org2, &p.UserID, "reseller.account.create", "organization", org.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"name": name, "admin_email": email, "plan": req.PlanCode})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"account": map[string]any{
			"id": org.ID, "name": org.Name, "slug": org.Slug, "status": org.Status,
			"plan_code": req.PlanCode, "sites": 0,
		},
		"owner_email":   email,
		"temp_password": tempPassword, // shown once
	})
}

type subAccountStatusRequest struct {
	Status string `json:"status"`
}

func (s *Server) handleSetSubAccountStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "accountID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid account id")
		return
	}
	var req subAccountStatusRequest
	if derr := httpx.Decode(w, r, &req); derr != nil || (req.Status != "active" && req.Status != "suspended") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "status must be active or suspended")
		return
	}
	cascaded, err := s.deps.Store.SetSubAccountStatusCascade(ctx, p.OrgID, id, req.Status)
	if err != nil {
		if err == store.ErrNotFound {
			httpx.Error(w, http.StatusNotFound, "not_found", "sub-account not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not update status")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "reseller.account.status", "organization", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"status": req.Status, "cascaded": cascaded})
	httpx.JSON(w, http.StatusOK, map[string]any{"id": id, "status": req.Status, "cascaded": cascaded})
}

// handleResellerBudget reports the reseller's allocation budget: for each
// resource its own plan caps, how much it has already handed out to its direct
// sub-accounts versus its own limit. An unconstrained reseller (no plan) returns
// an empty list — the UI then shows no budget bars.
func (s *Server) handleResellerBudget(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	_, limits, err := s.deps.Store.GetOrgPlanLimits(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not load plan")
		return
	}
	out := make([]map[string]any, 0)
	if len(limits) > 0 {
		alloc, aerr := s.deps.Store.SumSubAccountPlanLimits(ctx, p.OrgID, uuid.NullUUID{})
		if aerr != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not sum allocations")
			return
		}
		for _, key := range []string{"max_sites", "max_apps", "max_domains", "max_databases", "max_mailboxes", "max_nodes"} {
			lim := limits[key]
			if lim <= 0 {
				continue
			}
			out = append(out, map[string]any{
				"resource":  strings.TrimPrefix(key, "max_"),
				"allocated": alloc[key],
				"limit":     lim,
			})
		}
		// Sub-account COUNT is a budget too — counted, not summed from child plans.
		if max := limits["max_accounts"]; max > 0 {
			n, _ := s.deps.Store.CountSubAccounts(ctx, p.OrgID)
			out = append(out, map[string]any{"resource": "accounts", "allocated": n, "limit": max})
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"budget": out})
}

type resellerPackageRequest struct {
	Name   string         `json:"name"`
	Limits map[string]int `json:"limits"`
}

// packageExceedsOwnPlan reports whether any limit in a reseller package exceeds
// the reseller's own plan — you can't template more capacity than you have.
func (s *Server) packageExceedsOwnPlan(ctx context.Context, orgID uuid.UUID, limits map[string]int) (over bool, resource string, cap int) {
	_, own, err := s.deps.Store.GetOrgPlanLimits(ctx, orgID)
	if err != nil || len(own) == 0 {
		return false, "", 0
	}
	for k, v := range limits {
		if c := own[k]; c > 0 && v > c {
			return true, strings.TrimPrefix(k, "max_"), c
		}
	}
	return false, "", 0
}

// handleListResellerPackages lists the packages a reseller has defined for its
// own customers (its private plan templates).
func (s *Server) handleListResellerPackages(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	plans, err := s.deps.Store.ListPlansOwnedBy(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list packages")
		return
	}
	views := make([]map[string]any, 0, len(plans))
	for _, pl := range plans {
		views = append(views, planView(pl))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"packages": views})
}

// handleCreateResellerPackage defines a reseller-owned package. No single limit
// may exceed the reseller's OWN plan — you can't template more than you have.
func (s *Server) handleCreateResellerPackage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req resellerPackageRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a package name is required")
		return
	}
	limits := sanitizeLimits(req.Limits)
	if over, res, cap := s.packageExceedsOwnPlan(ctx, p.OrgID, limits); over {
		httpx.ErrorWithDetails(w, http.StatusForbidden, "over_budget",
			"a package limit can't exceed your own plan", map[string]any{"resource": res, "limit": cap})
		return
	}
	suffix, err := crypto.RandomHex(5)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate code")
		return
	}
	plan, err := s.deps.Store.CreatePlan(ctx, "pkg-"+suffix, strings.TrimSpace(req.Name), nil, 0, "EUR", "month",
		limits, uuid.NullUUID{UUID: p.OrgID, Valid: true})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create package")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "reseller.package.create", "billing_plan", plan.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"name": plan.Name})
	httpx.JSON(w, http.StatusCreated, map[string]any{"package": planView(*plan)})
}

// handleUpdateResellerPackage edits one of the reseller's own packages (name +
// limits), re-checking the per-key budget cap.
func (s *Server) handleUpdateResellerPackage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "planID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid package id")
		return
	}
	var req resellerPackageRequest
	if derr := httpx.Decode(w, r, &req); derr != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a package name is required")
		return
	}
	limits := sanitizeLimits(req.Limits)
	if over, res, cap := s.packageExceedsOwnPlan(ctx, p.OrgID, limits); over {
		httpx.ErrorWithDetails(w, http.StatusForbidden, "over_budget",
			"a package limit can't exceed your own plan", map[string]any{"resource": res, "limit": cap})
		return
	}
	plan, err := s.deps.Store.UpdatePlanOwnedBy(ctx, id, p.OrgID, strings.TrimSpace(req.Name), limits)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "package not found")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "reseller.package.update", "billing_plan", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"name": plan.Name})
	httpx.JSON(w, http.StatusOK, map[string]any{"package": planView(*plan)})
}

// resellerOwnsAccount verifies the account is the caller's direct sub-account
// (superadmin may act on any). Writes a 403 and returns false otherwise.
func (s *Server) resellerOwnsAccount(w http.ResponseWriter, ctx context.Context, p *middleware.Principal, accountID uuid.UUID) bool {
	if p.Superadmin {
		return true
	}
	ok, err := s.deps.Store.IsSubAccountOf(ctx, accountID, p.OrgID)
	if err != nil || !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "not your sub-account")
		return false
	}
	return true
}

// handleRunDunning runs the dunning sweep: suspends the caller's customers that
// have an overdue invoice. Paying the invoice reactivates them automatically.
func (s *Server) handleRunDunning(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	n, err := s.deps.Store.SuspendOverdueSubAccounts(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not run dunning")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "reseller.dunning.run", "organization", org.String(), audit.OutcomeSuccess, r,
		map[string]any{"suspended": n})
	httpx.JSON(w, http.StatusOK, map[string]any{"suspended": n})
}

// handleInvoiceSubAccount issues an invoice from a customer's plan — the reseller
// billing its customer (the WHMCS relationship). The invoice belongs to the
// sub-account org; the customer settles it from their own billing area.
func (s *Server) handleInvoiceSubAccount(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	accountID, err := uuid.Parse(chi.URLParam(r, "accountID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid account id")
		return
	}
	if !s.resellerOwnsAccount(w, ctx, p, accountID) {
		return
	}
	inv, code := s.billOrg(ctx, accountID)
	if billErrorStatus(w, code) {
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "reseller.invoice.create", "invoice", inv.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"account_id": accountID.String(), "number": inv.Number, "total_cents": inv.TotalCents})
	httpx.JSON(w, http.StatusCreated, map[string]any{"invoice": invoiceHeaderView(*inv)})
}

// handleListSubAccountInvoices lists a customer's invoices for its reseller.
func (s *Server) handleListSubAccountInvoices(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	accountID, err := uuid.Parse(chi.URLParam(r, "accountID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid account id")
		return
	}
	if !s.resellerOwnsAccount(w, ctx, p, accountID) {
		return
	}
	invs, err := s.deps.Store.ListInvoices(ctx, accountID)
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

// handleDeleteResellerPackage removes one of the reseller's own packages.
func (s *Server) handleDeleteResellerPackage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "planID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid package id")
		return
	}
	if err := s.deps.Store.DeletePlanOwnedBy(ctx, id, p.OrgID); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "package not found")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "reseller.package.delete", "billing_plan", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
