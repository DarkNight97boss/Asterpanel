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

// phpIniAllowed mirrors the agent's allowlist (defence in depth).
var phpIniAllowed = map[string]bool{
	"memory_limit": true, "upload_max_filesize": true, "post_max_size": true,
	"max_execution_time": true, "max_input_time": true, "max_input_vars": true,
	"max_file_uploads": true, "display_errors": true, "error_reporting": true,
	"log_errors": true, "date.timezone": true, "default_charset": true,
	"allow_url_fopen": true, "file_uploads": true, "expose_php": true,
	"short_open_tag": true, "session.gc_maxlifetime": true, "default_socket_timeout": true,
	"opcache.enable": true, "opcache.memory_consumption": true,
	"opcache.max_accelerated_files": true, "realpath_cache_size": true,
}

func (s *Server) siteFromURL(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, err := uuid.Parse(chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid site id")
		return uuid.Nil, false
	}
	if _, err := s.deps.Store.GetWebsite(ctx, p.OrgID, siteID); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "site not found")
		return uuid.Nil, false
	}
	return siteID, true
}

func (s *Server) handleListPhpSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, ok := s.siteFromURL(w, r)
	if !ok {
		return
	}
	items, err := s.deps.Store.ListPhpSettings(ctx, p.OrgID, siteID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list settings")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, it := range items {
		views = append(views, map[string]any{"id": it.ID, "directive": it.Directive, "value": it.Value})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"settings": views, "allowed": phpIniKeys()})
}

func phpIniKeys() []string {
	keys := make([]string, 0, len(phpIniAllowed))
	for k := range phpIniAllowed {
		keys = append(keys, k)
	}
	return keys
}

type setPhpSettingRequest struct {
	Directive string `json:"directive"`
	Value     string `json:"value"`
}

func (s *Server) handleSetPhpSetting(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, ok := s.siteFromURL(w, r)
	if !ok {
		return
	}
	var req setPhpSettingRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	directive := strings.TrimSpace(req.Directive)
	value := strings.TrimSpace(req.Value)
	if !phpIniAllowed[directive] {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "directive is not in the allowlist")
		return
	}
	if value == "" || strings.ContainsAny(value, "\n\r;[]") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid value")
		return
	}
	it, err := s.deps.Store.UpsertPhpSetting(ctx, p.OrgID, siteID, directive, value)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not save setting")
		return
	}
	jobID, dispatched := s.applyPhpIni(ctx, p, siteID)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "php.setting.set", "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"directive": directive, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"setting":  map[string]any{"id": it.ID, "directive": it.Directive, "value": it.Value},
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeletePhpSetting(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, ok := s.siteFromURL(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "settingID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeletePhpSetting(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applyPhpIni(ctx, p, siteID)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "php.setting.delete", "website", siteID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyPhpIni renders the site's php.ini overrides and dispatches
// runtime.phpini.apply to the site's node.
func (s *Server) applyPhpIni(ctx context.Context, p *middleware.Principal, siteID uuid.UUID) (uuid.UUID, bool) {
	items, err := s.deps.Store.ListPhpSettings(ctx, p.OrgID, siteID)
	if err != nil {
		return uuid.Nil, false
	}
	site, err := s.deps.Store.GetWebsite(ctx, p.OrgID, siteID)
	if err != nil || !site.ServerNodeID.Valid {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeRuntimePhpIni, site.ServerNodeID.UUID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(items))
	for _, it := range items {
		list = append(list, map[string]any{"directive": it.Directive, "value": it.Value})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeRuntimePhpIni, site.ServerNodeID.UUID,
		map[string]any{"website_id": siteID.String(), "settings": list})
	return jobID, dispatched
}
