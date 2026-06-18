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

func hotlinkView(h store.HotlinkProtection) map[string]any {
	return map[string]any{
		"id": h.ID, "domain": h.Domain,
		"allowed_referers": h.AllowedReferers, "extensions": h.Extensions,
	}
}

func (s *Server) handleListHotlink(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListHotlink(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list hotlink rules")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, h := range items {
		views = append(views, hotlinkView(h))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"hotlink": views})
}

type createHotlinkRequest struct {
	Domain          string   `json:"domain"`
	AllowedReferers []string `json:"allowed_referers"`
	Extensions      []string `json:"extensions"`
}

func (s *Server) handleCreateHotlink(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createHotlinkRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(req.Domain))
	if !strings.Contains(domain, ".") || strings.ContainsAny(domain, " /") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid domain is required")
		return
	}
	referers := make([]string, 0, len(req.AllowedReferers))
	for _, ref := range req.AllowedReferers {
		ref = strings.ToLower(strings.TrimSpace(ref))
		if ref == "" {
			continue
		}
		if !strings.Contains(ref, ".") || strings.ContainsAny(ref, " /") {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "each allowed referer must be a domain")
			return
		}
		referers = append(referers, ref)
	}
	exts := make([]string, 0, len(req.Extensions))
	for _, e := range req.Extensions {
		e = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(e), ".")))
		if e == "" {
			continue
		}
		if !isAlnum(e) {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "extensions must be alphanumeric")
			return
		}
		exts = append(exts, e)
	}
	h, err := s.deps.Store.UpsertHotlink(ctx, store.CreateHotlinkParams{
		OrgID: p.OrgID, Domain: domain, AllowedReferers: referers, Extensions: exts,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not save hotlink rule")
		return
	}
	jobID, dispatched := s.applyProtection(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "hotlink.create", "hotlink_protection", h.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"domain": domain, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"hotlink":  hotlinkView(*h),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteHotlink(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "hotlinkID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteHotlink(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyProtection(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "hotlink.delete", "hotlink_protection", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func isAlnum(s string) bool {
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return s != ""
}
