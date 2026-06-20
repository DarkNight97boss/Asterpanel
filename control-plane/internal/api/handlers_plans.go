package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

// planLimitKeys is the allowlist of quota keys a hosting package may carry. They
// mirror the resources overQuota / UsageCounts understand, so a stray key can't
// silently become an unenforced "limit".
var planLimitKeys = map[string]bool{
	"max_sites": true, "max_apps": true, "max_domains": true,
	"max_databases": true, "max_mailboxes": true, "max_nodes": true,
}

func sanitizeLimits(in map[string]int) map[string]int {
	out := map[string]int{}
	for k, v := range in {
		if planLimitKeys[k] && v >= 0 {
			out[k] = v
		}
	}
	return out
}

func validPlanCode(s string) bool {
	if s == "" || len(s) > 40 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

var validPlanIntervals = map[string]bool{"month": true, "year": true}

func planView(p store.BillingPlan) map[string]any {
	desc := ""
	if p.Description != nil {
		desc = *p.Description
	}
	return map[string]any{
		"id": p.ID, "code": p.Code, "name": p.Name, "description": desc,
		"price_cents": p.PriceCents, "currency": p.Currency, "interval": p.Interval,
		"limits": p.Limits, "is_active": p.IsActive, "created_at": p.CreatedAt,
	}
}

func (s *Server) handleListPlans(w http.ResponseWriter, r *http.Request) {
	plans, err := s.deps.Store.ListPlans(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list plans")
		return
	}
	views := make([]map[string]any, 0, len(plans))
	for _, p := range plans {
		views = append(views, planView(p))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"plans": views})
}

type createPlanRequest struct {
	Code        string         `json:"code"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	PriceCents  int            `json:"price_cents"`
	Currency    string         `json:"currency"`
	Interval    string         `json:"interval"`
	Limits      map[string]int `json:"limits"`
}

func (s *Server) handleCreatePlan(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createPlanRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	req.Code = strings.TrimSpace(strings.ToLower(req.Code))
	req.Name = strings.TrimSpace(req.Name)
	if !validPlanCode(req.Code) || req.Name == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a lowercase code and a name are required")
		return
	}
	currency := strings.ToUpper(strings.TrimSpace(req.Currency))
	if currency == "" {
		currency = "EUR"
	}
	interval := strings.TrimSpace(req.Interval)
	if interval == "" {
		interval = "month"
	}
	if !validPlanIntervals[interval] {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "interval must be month or year")
		return
	}
	if req.PriceCents < 0 {
		req.PriceCents = 0
	}
	desc := strings.TrimSpace(req.Description)
	plan, err := s.deps.Store.CreatePlan(ctx, req.Code, req.Name, &desc, req.PriceCents, currency, interval, sanitizeLimits(req.Limits))
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create plan (code may already exist)")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "plan.create", "billing", plan.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"code": plan.Code})
	httpx.JSON(w, http.StatusCreated, map[string]any{"plan": planView(*plan)})
}

func (s *Server) handleGetPlan(w http.ResponseWriter, r *http.Request) {
	planID, err := uuid.Parse(chi.URLParam(r, "planID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid plan id")
		return
	}
	plan, err := s.deps.Store.GetPlan(r.Context(), planID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "plan not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"plan": planView(*plan)})
}

type updatePlanRequest struct {
	Name        *string         `json:"name"`
	Description *string         `json:"description"`
	PriceCents  *int            `json:"price_cents"`
	Limits      *map[string]int `json:"limits"`
	IsActive    *bool           `json:"is_active"`
}

func (s *Server) handleUpdatePlan(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	planID, err := uuid.Parse(chi.URLParam(r, "planID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid plan id")
		return
	}
	var req updatePlanRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	var limitsJSON *string
	if req.Limits != nil {
		raw, _ := json.Marshal(sanitizeLimits(*req.Limits))
		str := string(raw)
		limitsJSON = &str
	}
	plan, err := s.deps.Store.UpdatePlan(ctx, planID, req.Name, req.Description, req.PriceCents, limitsJSON, req.IsActive)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "plan not found")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "plan.update", "billing", planID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"plan": planView(*plan)})
}

func (s *Server) handleDeletePlan(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	planID, err := uuid.Parse(chi.URLParam(r, "planID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid plan id")
		return
	}
	if err := s.deps.Store.DeletePlan(ctx, planID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete plan")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "plan.delete", "billing", planID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

type assignPlanRequest struct {
	PlanCode string `json:"plan_code"`
}

// handleAssignSubAccountPlan (re)assigns a hosting package to one of the caller's
// sub-accounts. An empty plan_code clears the assignment (unlimited).
func (s *Server) handleAssignSubAccountPlan(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	accountID, err := uuid.Parse(chi.URLParam(r, "accountID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid account id")
		return
	}
	// A reseller may only re-plan its own sub-accounts; superadmin may re-plan any.
	if !p.Superadmin {
		ok, serr := s.deps.Store.IsSubAccountOf(ctx, accountID, p.OrgID)
		if serr != nil || !ok {
			httpx.Error(w, http.StatusForbidden, "forbidden", "not your sub-account")
			return
		}
	}
	var req assignPlanRequest
	_ = httpx.Decode(w, r, &req)
	req.PlanCode = strings.TrimSpace(req.PlanCode)

	var planID uuid.NullUUID
	if req.PlanCode != "" {
		id, gerr := s.deps.Store.GetPlanIDByCode(ctx, req.PlanCode)
		if gerr != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "unknown plan code")
			return
		}
		planID = uuid.NullUUID{UUID: id, Valid: true}
	}
	if err := s.deps.Store.SetOrgPlan(ctx, accountID, planID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not assign plan")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "reseller.account.plan", "organization", accountID.String(), audit.OutcomeSuccess, r,
		map[string]any{"plan_code": req.PlanCode})
	httpx.JSON(w, http.StatusOK, map[string]any{"assigned": true, "plan_code": req.PlanCode})
}
