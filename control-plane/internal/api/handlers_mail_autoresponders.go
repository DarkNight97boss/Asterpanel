package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

const dateLayout = "2006-01-02"

func dateStr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Format(dateLayout)
}

// parseDate parses a YYYY-MM-DD string; empty/invalid yields nil (no bound).
func parseDate(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return nil
	}
	return &t
}

func autoresponderView(a store.MailAutoresponder) map[string]any {
	return map[string]any{
		"id": a.ID, "address": a.Address, "subject": a.Subject, "body": a.Body,
		"interval_days": a.IntervalDays, "start_date": dateStr(a.StartDate),
		"end_date": dateStr(a.EndDate), "enabled": a.Enabled,
	}
}

func (s *Server) handleListAutoresponders(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListAutoresponders(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list autoresponders")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, a := range items {
		views = append(views, autoresponderView(a))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"autoresponders": views})
}

type createAutoresponderRequest struct {
	Address      string `json:"address"`
	Subject      string `json:"subject"`
	Body         string `json:"body"`
	IntervalDays int    `json:"interval_days"`
	StartDate    string `json:"start_date"`
	EndDate      string `json:"end_date"`
}

func (s *Server) handleCreateAutoresponder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createAutoresponderRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	address := strings.ToLower(strings.TrimSpace(req.Address))
	subject := strings.TrimSpace(req.Subject)
	if !validEmailAddr(address) || subject == "" || strings.TrimSpace(req.Body) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "address, subject and body are required")
		return
	}
	interval := req.IntervalDays
	if interval < 1 || interval > 30 {
		interval = 1
	}
	a, err := s.deps.Store.CreateAutoresponder(ctx, store.CreateAutoresponderParams{
		OrgID: p.OrgID, Address: address, Subject: subject, Body: req.Body,
		IntervalDays: interval, StartDate: parseDate(req.StartDate), EndDate: parseDate(req.EndDate),
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create autoresponder (already exists?)")
		return
	}
	jobID, dispatched := s.applyAutoresponders(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.autoresponder.create", "mail_autoresponder", a.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"address": address, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"autoresponder": autoresponderView(*a),
		"dispatch":      map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteAutoresponder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "autoresponderID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteAutoresponder(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyAutoresponders(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.autoresponder.delete", "mail_autoresponder", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyAutoresponders renders every autoresponder for the org and dispatches
// mail.autoresponder.apply so the agent regenerates the global Sieve script.
func (s *Server) applyAutoresponders(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	items, err := s.deps.Store.ListAutoresponders(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeMailAutoresponder, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(items))
	for _, a := range items {
		if !a.Enabled {
			continue
		}
		list = append(list, map[string]any{
			"address": a.Address, "subject": a.Subject, "body": a.Body,
			"interval_days": a.IntervalDays, "start_date": dateStr(a.StartDate), "end_date": dateStr(a.EndDate),
		})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeMailAutoresponder, node.ID, map[string]any{"autoresponders": list})
	return jobID, dispatched
}
