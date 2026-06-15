package api

import (
	"net/http"
	"time"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

type agentEnrollRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	CSRPem          string `json:"csr_pem"`
}

// handleAgentEnroll exchanges a one-time bootstrap token + CSR for a CA-signed
// mTLS certificate. Authenticated by possession of the (single-use, short-TTL)
// enrollment token, not by a session — this is how a brand-new agent bootstraps.
func (s *Server) handleAgentEnroll(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if s.deps.CA == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "enrollment_unavailable", "CA not configured")
		return
	}

	var req agentEnrollRequest
	if err := httpx.Decode(w, r, &req); err != nil || req.EnrollmentToken == "" || req.CSRPem == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "enrollment_token and csr_pem are required")
		return
	}

	reg, err := s.deps.Store.GetEnrollmentByTokenHash(ctx, crypto.SHA256([]byte(req.EnrollmentToken)))
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid_token", "invalid enrollment token")
		return
	}
	if reg.Status != "pending" || reg.Expired {
		httpx.Error(w, http.StatusUnauthorized, "invalid_token", "enrollment token already used or expired")
		return
	}

	certPEM, serial, fingerprint, err := s.deps.CA.SignCSR(
		[]byte(req.CSRPem), reg.ServerNodeID.String(), 90*24*time.Hour, time.Now())
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_csr", "could not sign CSR")
		return
	}

	if err := s.deps.Store.CompleteEnrollment(ctx, reg.ID, reg.ServerNodeID, string(certPEM), serial, fingerprint); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not complete enrollment")
		return
	}

	org := reg.OrgID
	_ = s.deps.Audit.Append(ctx, audit.Entry{
		OrganizationID: &org,
		ActorType:      audit.ActorAgent,
		Action:         "node.enroll.complete",
		ResourceType:   "server_node",
		ResourceID:     reg.ServerNodeID.String(),
		Outcome:        audit.OutcomeSuccess,
		IP:             clientIP(r),
		RequestID:      middleware.RequestIDFrom(ctx),
		Metadata:       map[string]any{"cert_serial": serial, "cert_fingerprint": fingerprint},
	})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"node_id":          reg.ServerNodeID,
		"certificate":      string(certPEM),
		"ca_certificate":   string(s.deps.CA.CertPEM()),
		"cert_fingerprint": fingerprint,
	})
}
