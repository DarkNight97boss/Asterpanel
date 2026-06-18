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
)

func (s *Server) handleGetSpam(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	st, err := s.deps.Store.GetSpamSettings(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not load spam settings")
		return
	}
	rules, err := s.deps.Store.ListSpamRules(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not load spam rules")
		return
	}
	ruleViews := make([]map[string]any, 0, len(rules))
	for _, rl := range rules {
		ruleViews = append(ruleViews, map[string]any{"id": rl.ID, "kind": rl.Kind, "value": rl.Value})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"settings": map[string]any{
			"reject_score": st.RejectScore, "add_header_score": st.AddHeaderScore, "greylisting": st.Greylisting,
		},
		"rules": ruleViews,
	})
}

type updateSpamRequest struct {
	RejectScore    int  `json:"reject_score"`
	AddHeaderScore int  `json:"add_header_score"`
	Greylisting    bool `json:"greylisting"`
}

func (s *Server) handleUpdateSpamSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req updateSpamRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	if req.RejectScore < 1 || req.RejectScore > 100 || req.AddHeaderScore < 1 || req.AddHeaderScore > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "scores must be between 1 and 100")
		return
	}
	if _, err := s.deps.Store.UpdateSpamSettings(ctx, p.OrgID, req.RejectScore, req.AddHeaderScore, req.Greylisting); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not save settings")
		return
	}
	jobID, dispatched := s.applySpam(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "mail.spam.settings", "organization", p.OrgID.String(), audit.OutcomeSuccess, r,
		map[string]any{"reject_score": req.RejectScore, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{"dispatch": map[string]any{"id": jobID, "dispatched": dispatched}})
}

type createSpamRuleRequest struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

func (s *Server) handleCreateSpamRule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createSpamRuleRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	value := strings.ToLower(strings.TrimSpace(req.Value))
	if req.Kind != "allow" && req.Kind != "deny" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "kind must be allow or deny")
		return
	}
	// A sender address or a domain — must contain a dot and no spaces.
	if !strings.Contains(value, ".") || strings.ContainsAny(value, " \t\r\n") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "value must be a sender address or domain")
		return
	}
	rule, err := s.deps.Store.CreateSpamRule(ctx, p.OrgID, req.Kind, value)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create rule (already exists?)")
		return
	}
	jobID, dispatched := s.applySpam(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "mail.spam.rule.create", "mail_spam_rule", rule.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"kind": req.Kind, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"rule":     map[string]any{"id": rule.ID, "kind": rule.Kind, "value": rule.Value},
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteSpamRule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "ruleID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteSpamRule(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applySpam(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "mail.spam.rule.delete", "mail_spam_rule", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applySpam renders the org's Rspamd configuration and dispatches mail.spam.apply.
func (s *Server) applySpam(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	st, err := s.deps.Store.GetSpamSettings(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	rules, err := s.deps.Store.ListSpamRules(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeMailSpamApply, node.ID); !ok {
		return uuid.Nil, false
	}
	allow, deny := []string{}, []string{}
	for _, rl := range rules {
		if rl.Kind == "allow" {
			allow = append(allow, rl.Value)
		} else {
			deny = append(deny, rl.Value)
		}
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeMailSpamApply, node.ID, map[string]any{
		"reject_score": st.RejectScore, "add_header_score": st.AddHeaderScore,
		"greylisting": st.Greylisting, "allow": allow, "deny": deny,
	})
	return jobID, dispatched
}
