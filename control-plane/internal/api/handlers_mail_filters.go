package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

var (
	validFilterField  = map[string]bool{"from": true, "to": true, "subject": true, "cc": true}
	validFilterOp     = map[string]bool{"contains": true, "is": true, "matches": true}
	validFilterAction = map[string]bool{"fileinto": true, "discard": true, "redirect": true, "keep": true}
)

func filterView(f store.MailFilter) map[string]any {
	return map[string]any{
		"id": f.ID, "address": f.Address, "name": f.Name, "field": f.Field, "op": f.Op,
		"value": f.Value, "action": f.Action, "action_arg": f.ActionArg, "position": f.Position,
		"enabled": f.Enabled,
	}
}

func (s *Server) handleListFilters(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListFilters(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list filters")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, f := range items {
		views = append(views, filterView(f))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"filters": views})
}

type createFilterRequest struct {
	Address   string `json:"address"`
	Name      string `json:"name"`
	Field     string `json:"field"`
	Op        string `json:"op"`
	Value     string `json:"value"`
	Action    string `json:"action"`
	ActionArg string `json:"action_arg"`
	Position  int    `json:"position"`
}

func (s *Server) handleCreateFilter(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createFilterRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	address := strings.ToLower(strings.TrimSpace(req.Address))
	name := strings.TrimSpace(req.Name)
	value := strings.TrimSpace(req.Value)
	arg := strings.TrimSpace(req.ActionArg)
	if !validEmailAddr(address) || name == "" || value == "" ||
		!validFilterField[req.Field] || !validFilterOp[req.Op] || !validFilterAction[req.Action] {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "address, name, value and a valid field/op/action are required")
		return
	}
	switch req.Action {
	case "fileinto":
		if arg == "" {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "fileinto requires a target folder")
			return
		}
	case "redirect":
		arg = strings.ToLower(arg)
		if !validEmailAddr(arg) {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "redirect requires a valid email address")
			return
		}
	}
	f, err := s.deps.Store.CreateFilter(ctx, store.CreateFilterParams{
		OrgID: p.OrgID, Address: address, Name: name, Field: req.Field, Op: req.Op,
		Value: value, Action: req.Action, ActionArg: arg, Position: req.Position,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create filter")
		return
	}
	jobID, dispatched := s.applyFilters(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.filter.create", "mail_filter", f.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"address": address, "action": req.Action, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"filter":   filterView(*f),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteFilter(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "filterID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteFilter(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyFilters(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.filter.delete", "mail_filter", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyFilters renders every filter for the org and dispatches mail.filter.apply
// so the agent regenerates the global Sieve filter script.
func (s *Server) applyFilters(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	items, err := s.deps.Store.ListFilters(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeMailFilterApply, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(items))
	for _, f := range items {
		if !f.Enabled {
			continue
		}
		list = append(list, map[string]any{
			"address": f.Address, "name": f.Name, "field": f.Field, "op": f.Op,
			"value": f.Value, "action": f.Action, "action_arg": f.ActionArg,
		})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeMailFilterApply, node.ID, map[string]any{"filters": list})
	return jobID, dispatched
}
