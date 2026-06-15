package api

import (
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
	return map[string]any{
		"id":         a.ID,
		"name":       a.Name,
		"slug":       a.Slug,
		"status":     a.Status,
		"plan_code":  a.PlanCode,
		"sites":      a.Sites,
		"created_at": a.CreatedAt,
	}
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
	if err := s.deps.Store.SetSubAccountStatus(ctx, p.OrgID, id, req.Status); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "sub-account not found")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "reseller.account.status", "organization", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"status": req.Status})
	httpx.JSON(w, http.StatusOK, map[string]any{"id": id, "status": req.Status})
}
