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

var validWafMatch = map[string]bool{"path": true, "user_agent": true, "ip": true}

func wafView(r store.WafRule) map[string]any {
	return map[string]any{
		"id": r.ID, "match_type": r.MatchType, "pattern": r.Pattern, "note": r.Note,
	}
}

func (s *Server) handleListWaf(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	rules, err := s.deps.Store.ListWafRules(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list rules")
		return
	}
	views := make([]map[string]any, 0, len(rules))
	for _, wr := range rules {
		views = append(views, wafView(wr))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"rules": views})
}

type createWafRequest struct {
	MatchType string `json:"match_type"`
	Pattern   string `json:"pattern"`
	Note      string `json:"note"`
}

func (s *Server) handleCreateWaf(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createWafRequest
	if err := httpx.Decode(w, r, &req); err != nil || !validWafMatch[req.MatchType] || strings.TrimSpace(req.Pattern) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "match_type (path|user_agent|ip) and pattern are required")
		return
	}
	var note *string
	if strings.TrimSpace(req.Note) != "" {
		note = &req.Note
	}
	rule, err := s.deps.Store.CreateWafRule(ctx, p.OrgID, req.MatchType, req.Pattern, note)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create rule")
		return
	}
	jobID, dispatched := s.applyWaf(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "waf.create", "waf_rule", rule.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"match_type": req.MatchType, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"rule":     wafView(*rule),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleUpdateWaf(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "ruleID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	var req createWafRequest
	if err := httpx.Decode(w, r, &req); err != nil || !validWafMatch[req.MatchType] || strings.TrimSpace(req.Pattern) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "match_type (path|user_agent|ip) and pattern are required")
		return
	}
	var note *string
	if strings.TrimSpace(req.Note) != "" {
		note = &req.Note
	}
	rule, err := s.deps.Store.UpdateWafRule(ctx, p.OrgID, id, req.MatchType, req.Pattern, note)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "rule not found")
		return
	}
	jobID, dispatched := s.applyWaf(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "waf.update", "waf_rule", rule.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"match_type": req.MatchType, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"rule":     wafView(*rule),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteWaf(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "ruleID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteWafRule(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyWaf(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "waf.delete", "waf_rule", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyWaf renders the org's WAF ruleset and dispatches waf.apply to a node so
// the agent regenerates the Caddy WAF snippet.
func (s *Server) applyWaf(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	rules, err := s.deps.Store.ListWafRules(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeWAFApply, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(rules))
	for _, wr := range rules {
		list = append(list, map[string]any{"match_type": wr.MatchType, "pattern": wr.Pattern})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeWAFApply, node.ID, map[string]any{"rules": list})
	return jobID, dispatched
}
