package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

// handleEnsureCaldav launches the Radicale CalDAV/CardDAV server on a node.
func (s *Server) handleEnsureCaldav(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusConflict, "no_node", "no node available")
		return
	}
	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeCaldavEnsure, node.ID); !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeCaldavEnsure, node.ID, map[string]any{})
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "caldav.ensure", "node", node.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String()})
	httpx.JSON(w, http.StatusAccepted, map[string]any{"job": map[string]any{"id": jobID, "dispatched": dispatched}})
}

func (s *Server) handleListCaldav(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListCaldavAccounts(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list accounts")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, a := range items {
		views = append(views, map[string]any{"id": a.ID, "username": a.Username})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"accounts": views})
}

type createCaldavRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleCreateCaldav(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createCaldavRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if username == "" || strings.ContainsAny(username, " :/\t") || len(req.Password) < 6 {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "username and a password (min 6 chars) are required")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not hash password")
		return
	}
	a, err := s.deps.Store.CreateCaldavAccount(ctx, p.OrgID, username, string(hash))
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create account (already exists?)")
		return
	}
	jobID, dispatched := s.applyCaldav(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "caldav.account.create", "caldav_account", a.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"username": username, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"account":  map[string]any{"id": a.ID, "username": a.Username},
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteCaldav(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "accountID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteCaldavAccount(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyCaldav(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "caldav.account.delete", "caldav_account", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyCaldav renders every CalDAV account and dispatches caldav.user.apply so
// the agent regenerates the Radicale users file.
func (s *Server) applyCaldav(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	accounts, err := s.deps.Store.ListCaldavAccounts(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeCaldavUserApply, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(accounts))
	for _, a := range accounts {
		list = append(list, map[string]any{"username": a.Username, "password_hash": a.PasswordHash})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeCaldavUserApply, node.ID, map[string]any{"accounts": list})
	return jobID, dispatched
}
