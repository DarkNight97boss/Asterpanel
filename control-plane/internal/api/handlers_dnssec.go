package api

import (
	"encoding/json"
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

func dnssecView(d store.Dnssec) map[string]any {
	return map[string]any{
		"id": d.ID, "domain": d.Domain, "ds_record": d.DsRecord,
		"algorithm": d.Algorithm, "enabled": d.Enabled,
	}
}

type dnssecResult struct {
	Domain    string `json:"domain"`
	Signed    bool   `json:"signed"`
	DsRecords []struct {
		KeyTag     int    `json:"key_tag"`
		Algorithm  int    `json:"algorithm"`
		DigestType int    `json:"digest_type"`
		Digest     string `json:"digest"`
		Rdata      string `json:"rdata"`
	} `json:"ds_records"`
}

func (s *Server) handleListDnssec(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListDnssec(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list DNSSEC")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, d := range items {
		views = append(views, dnssecView(d))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"dnssec": views})
}

type enableDnssecRequest struct {
	Domain string `json:"domain"`
}

// handleEnableDnssec signs the zone on the node (awaited job), stores the DS
// record and returns it for the customer to publish at their registrar.
func (s *Server) handleEnableDnssec(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req enableDnssecRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(req.Domain))
	if !strings.Contains(domain, ".") || strings.ContainsAny(domain, " /") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid domain is required")
		return
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusConflict, "no_node", "no node available")
		return
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeDNSSECEnable, node.ID, map[string]any{"domain": domain})
	if err != nil {
		fileJobError(w, err)
		return
	}
	var dr dnssecResult
	if err := json.Unmarshal(res, &dr); err != nil || len(dr.DsRecords) == 0 {
		httpx.Error(w, http.StatusBadGateway, "dnssec_failed", "no DS record was produced on the node")
		return
	}
	primary := dr.DsRecords[0]
	d, err := s.deps.Store.UpsertDnssec(ctx, p.OrgID, domain, primary.Rdata, primary.Algorithm)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store DNSSEC state")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "dns.dnssec.enable", "domain", domain, audit.OutcomeSuccess, r,
		map[string]any{"algorithm": primary.Algorithm})
	httpx.JSON(w, http.StatusOK, map[string]any{"dnssec": dnssecView(*d), "ds_records": dr.DsRecords})
}

func (s *Server) handleDisableDnssec(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "dnssecID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	d, err := s.deps.Store.GetDnssec(ctx, p.OrgID, id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "DNSSEC entry not found")
		return
	}
	if node := s.firstNode(ctx, p.OrgID); node != nil {
		if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeDNSSECDisable, node.ID); ok {
			s.signPersistDispatch(ctx, p, jobs.TypeDNSSECDisable, node.ID, map[string]any{"domain": d.Domain})
		}
	}
	if err := s.deps.Store.DeleteDnssec(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "dns.dnssec.disable", "domain", d.Domain, audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
