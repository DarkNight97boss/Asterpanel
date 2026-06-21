package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

var ticketPriorities = map[string]bool{"low": true, "normal": true, "high": true}

func ticketMessageView(m store.TicketMessage) map[string]any {
	var author any
	if m.Author.Valid {
		author = m.Author.UUID
	}
	return map[string]any{
		"id": m.ID, "author_user_id": author, "body": m.Body,
		"staff": m.Staff, "created_at": m.CreatedAt,
	}
}

func ticketView(t store.Ticket) map[string]any {
	var creator any
	if t.CreatedBy.Valid {
		creator = t.CreatedBy.UUID
	}
	return map[string]any{
		"id": t.ID, "subject": t.Subject, "status": t.Status, "priority": t.Priority,
		"created_by": creator, "created_at": t.CreatedAt, "updated_at": t.UpdatedAt,
		"message_count": t.MessageCount,
	}
}

func (s *Server) handleListTickets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	tickets, err := s.deps.Store.ListTickets(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list tickets")
		return
	}
	views := make([]map[string]any, 0, len(tickets))
	for _, t := range tickets {
		views = append(views, ticketView(t))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"tickets": views})
}

type createTicketRequest struct {
	Subject  string `json:"subject"`
	Priority string `json:"priority"`
	Body     string `json:"body"`
}

func (s *Server) handleCreateTicket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createTicketRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	subject := strings.TrimSpace(req.Subject)
	body := strings.TrimSpace(req.Body)
	if subject == "" || body == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "subject and message are required")
		return
	}
	priority := strings.ToLower(strings.TrimSpace(req.Priority))
	if !ticketPriorities[priority] {
		priority = "normal"
	}
	t, err := s.deps.Store.CreateTicket(ctx, p.OrgID, subject, priority, p.UserID, body)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not open ticket")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "support.ticket.create", "support_ticket", t.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"subject": subject, "priority": priority})
	httpx.JSON(w, http.StatusCreated, map[string]any{"ticket": ticketView(*t)})
}

func (s *Server) handleGetTicket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "ticketID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid ticket id")
		return
	}
	t, err := s.deps.Store.GetTicket(ctx, p.OrgID, id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "ticket not found")
		return
	}
	msgs := make([]map[string]any, 0, len(t.Messages))
	for _, m := range t.Messages {
		msgs = append(msgs, ticketMessageView(m))
	}
	v := ticketView(*t)
	v["messages"] = msgs
	httpx.JSON(w, http.StatusOK, map[string]any{"ticket": v})
}

type ticketReplyRequest struct {
	Body string `json:"body"`
}

func (s *Server) handleReplyTicket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "ticketID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid ticket id")
		return
	}
	var req ticketReplyRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Body) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a message body is required")
		return
	}
	// A superadmin replying is staff; the org's own members are the customer side.
	m, err := s.deps.Store.AddTicketMessage(ctx, p.OrgID, id, p.UserID, strings.TrimSpace(req.Body), p.Superadmin)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "ticket not found")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "support.ticket.reply", "support_ticket", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusCreated, map[string]any{"message": ticketMessageView(*m)})
}

type ticketStatusRequest struct {
	Status string `json:"status"`
}

func (s *Server) handleSetTicketStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "ticketID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid ticket id")
		return
	}
	var req ticketStatusRequest
	if derr := httpx.Decode(w, r, &req); derr != nil ||
		(req.Status != "open" && req.Status != "pending" && req.Status != "closed") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "status must be open, pending or closed")
		return
	}
	t, err := s.deps.Store.SetTicketStatus(ctx, p.OrgID, id, req.Status)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "ticket not found")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "support.ticket.status", "support_ticket", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"status": req.Status})
	httpx.JSON(w, http.StatusOK, map[string]any{"ticket": ticketView(*t)})
}
