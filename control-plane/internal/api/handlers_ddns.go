package api

import (
	"net"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func ddnsView(h store.DdnsHost) map[string]any {
	return map[string]any{
		"id": h.ID, "domain_id": h.DomainID, "name": h.Name, "token": h.Token,
		"last_ip": h.LastIP, "updated_at": h.UpdatedAt,
		"update_url": "/api/v1/ddns/update?token=" + h.Token,
	}
}

func (s *Server) handleListDdns(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListDdnsHosts(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list dynamic DNS hosts")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, h := range items {
		views = append(views, ddnsView(h))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ddns": views})
}

type createDdnsRequest struct {
	DomainID string `json:"domain_id"`
	Name     string `json:"name"`
}

func validRecordName(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_') {
			return false
		}
	}
	return true
}

func (s *Server) handleCreateDdns(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createDdnsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	domainID, err := uuid.Parse(req.DomainID)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid domain_id is required")
		return
	}
	name := strings.ToLower(strings.TrimSpace(req.Name))
	if !validRecordName(name) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "name must be a DNS label")
		return
	}
	if _, _, zerr := s.deps.Store.ZoneForDomain(ctx, p.OrgID, domainID); zerr != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "domain not found")
		return
	}
	token, err := crypto.RandomTokenURL(24)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate token")
		return
	}
	h, err := s.deps.Store.CreateDdnsHost(ctx, p.OrgID, domainID, name, token)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create host (already exists?)")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "dns.ddns.create", "ddns_host", h.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"name": name})
	httpx.JSON(w, http.StatusCreated, map[string]any{"ddns": ddnsView(*h)})
}

func (s *Server) handleDeleteDdns(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "ddnsID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteDdnsHost(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "dns.ddns.delete", "ddns_host", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func ddnsClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func ddnsText(w http.ResponseWriter, code int, body string) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(body + "\n"))
}

// handleDdnsUpdate is the PUBLIC, token-authenticated DynDNS-style update: it
// points the host's A record at the caller's IP (or ?ip=), re-applies the zone
// and answers with a plain-text status. No JWT — the token IS the credential.
func (s *Server) handleDdnsUpdate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		ddnsText(w, http.StatusUnauthorized, "badauth")
		return
	}
	host, err := s.deps.Store.GetDdnsByToken(ctx, token)
	if err != nil {
		ddnsText(w, http.StatusUnauthorized, "badauth")
		return
	}
	ip := strings.TrimSpace(r.URL.Query().Get("ip"))
	if ip == "" {
		ip = ddnsClientIP(r)
	}
	if net.ParseIP(ip) == nil || net.ParseIP(ip).To4() == nil {
		ddnsText(w, http.StatusBadRequest, "badip")
		return
	}
	zoneID, _, zerr := s.deps.Store.ZoneForDomain(ctx, host.OrganizationID, host.DomainID)
	if zerr != nil {
		ddnsText(w, http.StatusNotFound, "nohost")
		return
	}
	if err := s.deps.Store.SetARecord(ctx, zoneID, host.OrganizationID, host.Name, ip, 300); err != nil {
		ddnsText(w, http.StatusInternalServerError, "dnserr")
		return
	}
	// System-initiated dispatch scoped to the host's org (superadmin → OPA allows).
	sysP := &middleware.Principal{OrgID: host.OrganizationID, Superadmin: true}
	s.applyZone(ctx, sysP, zoneID)
	_ = s.deps.Store.UpdateDdnsIP(ctx, host.ID, ip)
	org := host.OrganizationID
	s.audit(ctx, &org, nil, "dns.ddns.update", "ddns_host", host.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"ip": ip})
	ddnsText(w, http.StatusOK, "good "+ip)
}
