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

func forwarderView(f store.MailForwarder) map[string]any {
	return map[string]any{
		"id": f.ID, "source": f.Source, "destinations": f.Destinations, "is_catchall": f.IsCatchall,
	}
}

func (s *Server) handleListForwarders(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	fwds, err := s.deps.Store.ListForwarders(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list forwarders")
		return
	}
	views := make([]map[string]any, 0, len(fwds))
	for _, f := range fwds {
		views = append(views, forwarderView(f))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"forwarders": views})
}

type createForwarderRequest struct {
	Source       string   `json:"source"`
	Destinations []string `json:"destinations"`
}

// validForwardSource accepts a full address (sales@example.com) or a catch-all
// (@example.com).
func validForwardSource(s string) bool {
	if domain, ok := strings.CutPrefix(s, "@"); ok {
		return strings.Contains(domain, ".") && len(domain) > 1
	}
	return validEmailAddr(s)
}

func validEmailAddr(s string) bool {
	at := strings.IndexByte(s, '@')
	if at <= 0 || at != strings.LastIndexByte(s, '@') {
		return false
	}
	return strings.Contains(s[at+1:], ".")
}

// handleCreateForwarder stores a forwarder then re-applies the full virtual-alias
// map to the node so the node config always mirrors the database.
func (s *Server) handleCreateForwarder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createForwarderRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	source := strings.ToLower(strings.TrimSpace(req.Source))
	if !validForwardSource(source) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "source must be an address or @domain catch-all")
		return
	}
	dests := make([]string, 0, len(req.Destinations))
	for _, d := range req.Destinations {
		d = strings.ToLower(strings.TrimSpace(d))
		if d == "" {
			continue
		}
		if !validEmailAddr(d) {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "each destination must be a valid email address")
			return
		}
		dests = append(dests, d)
	}
	if len(dests) == 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "at least one destination is required")
		return
	}
	isCatchall := strings.HasPrefix(source, "@")
	f, err := s.deps.Store.CreateForwarder(ctx, p.OrgID, source, dests, isCatchall)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create forwarder (already exists?)")
		return
	}
	jobID, dispatched := s.applyForwarders(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.forwarder.create", "mail_forwarder", f.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"source": source, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"forwarder": forwarderView(*f),
		"dispatch":  map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteForwarder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "forwarderID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteForwarder(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyForwarders(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.forwarder.delete", "mail_forwarder", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyForwarders renders every forwarder for the org and dispatches
// mail.alias.apply so the agent regenerates the Postfix virtual-alias map.
func (s *Server) applyForwarders(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	fwds, err := s.deps.Store.ListForwarders(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeMailAliasApply, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(fwds))
	for _, f := range fwds {
		list = append(list, map[string]any{"source": f.Source, "destinations": f.Destinations})
	}
	// Mailing lists render into the same virtual-alias map: the list address
	// fans out to its members.
	if lists, err := s.deps.Store.ListsForApply(ctx, p.OrgID); err == nil {
		for _, l := range lists {
			if len(l.Members) == 0 {
				continue
			}
			list = append(list, map[string]any{"source": l.Address, "destinations": l.Members})
		}
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeMailAliasApply, node.ID, map[string]any{"forwarders": list})
	return jobID, dispatched
}
