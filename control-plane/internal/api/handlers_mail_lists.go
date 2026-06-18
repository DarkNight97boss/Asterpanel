package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

func (s *Server) handleListMailLists(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	lists, err := s.deps.Store.ListMailLists(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list mailing lists")
		return
	}
	views := make([]map[string]any, 0, len(lists))
	for _, l := range lists {
		members, _ := s.deps.Store.ListMembers(ctx, l.ID)
		emails := make([]string, 0, len(members))
		ids := make([]map[string]any, 0, len(members))
		for _, m := range members {
			emails = append(emails, m.Email)
			ids = append(ids, map[string]any{"id": m.ID, "email": m.Email})
		}
		views = append(views, map[string]any{"id": l.ID, "address": l.Address, "members": ids, "member_count": len(emails)})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"lists": views})
}

type createMailListRequest struct {
	Address string `json:"address"`
}

func (s *Server) handleCreateMailList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createMailListRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	address := strings.ToLower(strings.TrimSpace(req.Address))
	if !validEmailAddr(address) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid list address is required")
		return
	}
	l, err := s.deps.Store.CreateMailList(ctx, p.OrgID, address)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create list (already exists?)")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.list.create", "mail_list", l.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"address": address})
	httpx.JSON(w, http.StatusCreated, map[string]any{"list": map[string]any{"id": l.ID, "address": l.Address}})
}

func (s *Server) handleDeleteMailList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "listID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteMailList(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyForwarders(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.list.delete", "mail_list", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

type addMemberRequest struct {
	Email string `json:"email"`
}

func (s *Server) handleAddListMember(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	listID, err := uuid.Parse(chi.URLParam(r, "listID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid list id")
		return
	}
	var req addMemberRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !validEmailAddr(email) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid member email is required")
		return
	}
	m, err := s.deps.Store.AddListMember(ctx, p.OrgID, listID, email)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not add member (list not found or duplicate?)")
		return
	}
	jobID, dispatched := s.applyForwarders(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.list.member.add", "mail_list", listID.String(), audit.OutcomeSuccess, r,
		map[string]any{"email": email, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"member":   map[string]any{"id": m.ID, "email": m.Email},
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteListMember(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	memberID, err := uuid.Parse(chi.URLParam(r, "memberID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteListMember(ctx, p.OrgID, memberID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyForwarders(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.list.member.remove", "mail_list_member", memberID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
