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

func firewallView(r store.FirewallRule) map[string]any {
	return map[string]any{
		"id": r.ID, "action": r.Action, "source": r.Source, "port": r.Port, "note": r.Note,
	}
}

func (s *Server) handleListFirewall(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	rules, err := s.deps.Store.ListFirewallRules(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list rules")
		return
	}
	views := make([]map[string]any, 0, len(rules))
	for _, fr := range rules {
		views = append(views, firewallView(fr))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"rules": views})
}

type createFirewallRequest struct {
	Action string `json:"action"`
	Source string `json:"source"`
	Port   string `json:"port"`
	Note   string `json:"note"`
}

func (s *Server) handleCreateFirewall(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createFirewallRequest
	if err := httpx.Decode(w, r, &req); err != nil || (req.Action != "allow" && req.Action != "deny") || strings.TrimSpace(req.Source) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "action (allow|deny) and source are required")
		return
	}
	var note *string
	if strings.TrimSpace(req.Note) != "" {
		note = &req.Note
	}
	rule, err := s.deps.Store.CreateFirewallRule(ctx, p.OrgID, uuid.NullUUID{}, req.Action, req.Source, req.Port, note)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create rule")
		return
	}
	jobID, dispatched := s.applyFirewall(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "firewall.create", "firewall_rule", rule.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"action": req.Action, "source": req.Source, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"rule":     firewallView(*rule),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteFirewall(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "ruleID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteFirewallRule(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyFirewall(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "firewall.delete", "firewall_rule", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyFirewall renders the org's full rule set and dispatches firewall.apply.
func (s *Server) applyFirewall(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	rules, err := s.deps.Store.ListFirewallRules(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeFirewallApply, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(rules))
	for _, fr := range rules {
		list = append(list, map[string]any{"action": fr.Action, "source": fr.Source, "port": fr.Port})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeFirewallApply, node.ID, map[string]any{"rules": list})
	return jobID, dispatched
}
