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

var validDNSTypes = map[string]bool{
	"A": true, "AAAA": true, "CNAME": true, "MX": true,
	"TXT": true, "SRV": true, "NS": true, "CAA": true,
}

func domainView(d store.Domain) map[string]any {
	return map[string]any{
		"id":          d.ID,
		"fqdn":        d.FQDN,
		"status":      d.Status,
		"verified_at": d.VerifiedAt,
		"auto_renew":  d.AutoRenew,
		"created_at":  d.CreatedAt,
	}
}

func dnsRecordView(r store.DNSRecord) map[string]any {
	return map[string]any{
		"id":       r.ID,
		"zone":     r.ZoneName,
		"name":     r.Name,
		"type":     r.Type,
		"content":  r.Content,
		"ttl":      r.TTL,
		"priority": r.Priority,
		"proxied":  r.Proxied,
	}
}

func (s *Server) handleListDomains(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	domains, err := s.deps.Store.ListDomains(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list domains")
		return
	}
	views := make([]map[string]any, 0, len(domains))
	for _, d := range domains {
		views = append(views, domainView(d))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"domains": views})
}

type createDomainRequest struct {
	FQDN string `json:"fqdn"`
}

func (s *Server) handleCreateDomain(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createDomainRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	fqdn := strings.ToLower(strings.TrimSpace(req.FQDN))
	if fqdn == "" || !strings.Contains(fqdn, ".") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid fqdn is required")
		return
	}

	if over, used, limit := s.overQuota(ctx, p.OrgID, "domains"); over {
		httpx.ErrorWithDetails(w, http.StatusForbidden, "quota_exceeded", "plan domain limit reached",
			map[string]any{"used": used, "limit": limit})
		return
	}

	d, zoneID, err := s.deps.Store.CreateDomainWithZone(ctx, p.OrgID, fqdn)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create domain (already exists?)")
		return
	}

	jobID, dispatched := s.applyZone(ctx, p, zoneID)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "domain.create", "domain", d.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"fqdn": fqdn, "job_id": jobID.String()})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"domain": domainView(*d),
		"job":    map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleListDNSRecords(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	recs, err := s.deps.Store.ListDNSRecords(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list records")
		return
	}
	views := make([]map[string]any, 0, len(recs))
	for _, rec := range recs {
		views = append(views, dnsRecordView(rec))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"records": views})
}

type createDNSRecordRequest struct {
	DomainID string `json:"domain_id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Content  string `json:"content"`
	TTL      int    `json:"ttl"`
	Priority *int   `json:"priority"`
}

func (s *Server) handleCreateDNSRecord(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createDNSRecordRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	domainID, perr := uuid.Parse(req.DomainID)
	if perr != nil || !validDNSTypes[req.Type] || strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Content) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "domain_id, name, a valid type and content are required")
		return
	}
	zoneID, _, zerr := s.deps.Store.ZoneForDomain(ctx, p.OrgID, domainID)
	if zerr != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "domain not found")
		return
	}

	rec, err := s.deps.Store.CreateDNSRecord(ctx, store.CreateDNSRecordParams{
		OrgID: p.OrgID, ZoneID: zoneID, Name: req.Name, Type: req.Type,
		Content: req.Content, TTL: req.TTL, Priority: req.Priority,
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create record (duplicate?)")
		return
	}

	jobID, dispatched := s.applyZone(ctx, p, zoneID)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "dns.record.create", "dns_record", rec.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"type": req.Type, "job_id": jobID.String()})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"record": dnsRecordView(*rec),
		"job":    map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteDNSRecord(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	recordID, perr := uuid.Parse(chi.URLParam(r, "recordID"))
	if perr != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid record id")
		return
	}
	zoneID, err := s.deps.Store.DeleteDNSRecord(ctx, p.OrgID, recordID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "record not found")
		return
	}
	jobID, _ := s.applyZone(ctx, p, zoneID)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "dns.record.delete", "dns_record", recordID.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyZone fetches the full zone and dispatches a signed dns.apply job to a
// node so the agent regenerates the authoritative zone file.
func (s *Server) applyZone(ctx context.Context, p *middleware.Principal, zoneID uuid.UUID) (uuid.UUID, bool) {
	za, err := s.deps.Store.ZoneForApply(ctx, zoneID)
	if err != nil {
		s.deps.Log.Warn("dns.apply: zone lookup failed", "error", err)
		return uuid.Nil, false
	}
	nodes, err := s.deps.Store.ListNodes(ctx, p.OrgID)
	if err != nil || len(nodes) == 0 {
		s.deps.Log.Warn("dns.apply: no node available")
		return uuid.Nil, false
	}
	node := nodes[0]
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeDNSApply, node.ID); !ok {
		return uuid.Nil, false
	}

	recs := make([]map[string]any, 0, len(za.Records))
	for _, rec := range za.Records {
		recs = append(recs, map[string]any{
			"name": rec.Name, "type": rec.Type, "content": rec.Content,
			"ttl": rec.TTL, "priority": rec.Priority,
		})
	}
	payload := map[string]any{"zone": za.Name, "serial": za.Serial, "records": recs}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeDNSApply, node.ID, payload)
	return jobID, dispatched
}
