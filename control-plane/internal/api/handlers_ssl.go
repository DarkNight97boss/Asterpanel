package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func certificateView(c store.Certificate) map[string]any {
	return map[string]any{
		"id":         c.ID,
		"domain":     c.Domain,
		"issuer":     c.Issuer,
		"status":     c.Status,
		"auto_renew": c.AutoRenew,
		"expires_at": c.ExpiresAt,
		"created_at": c.CreatedAt,
	}
}

func (s *Server) handleListCertificates(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	certs, err := s.deps.Store.ListCertificates(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list certificates")
		return
	}
	views := make([]map[string]any, 0, len(certs))
	for _, c := range certs {
		views = append(views, certificateView(c))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"certificates": views})
}

type issueCertRequest struct {
	Domain   string `json:"domain"`
	Upstream string `json:"upstream"`
}

// handleIssueCertificate requests an ACME certificate by dispatching a signed
// cert.issue job; the agent configures the reverse proxy for automatic HTTPS.
func (s *Server) handleIssueCertificate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req issueCertRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Domain) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "domain is required")
		return
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeCertIssue, node.ID); !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	cert, err := s.deps.Store.CreateCertificate(ctx, p.OrgID, uuid.NullUUID{}, strings.ToLower(req.Domain))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not create certificate")
		return
	}

	payload := map[string]any{
		"certificate_id": cert.ID,
		"domain":         cert.Domain,
		"upstream":       req.Upstream,
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeCertIssue, node.ID, payload)

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "ssl.issue", "ssl_certificate", cert.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"domain": cert.Domain, "job_id": jobID.String()})

	httpx.JSON(w, http.StatusAccepted, map[string]any{
		"certificate": certificateView(*cert),
		"job":         map[string]any{"id": jobID, "dispatched": dispatched},
	})
}
