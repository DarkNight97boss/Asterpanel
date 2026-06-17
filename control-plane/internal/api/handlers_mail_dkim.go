package api

import (
	"net/http"
	"strings"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

type generateDKIMRequest struct {
	Domain   string `json:"domain"`
	Selector string `json:"selector"`
}

// handleGenerateDKIM kicks the agent to mint a DKIM keypair for `domain` on the
// mail-server container and returns the DNS records the customer must publish
// (DKIM TXT, SPF, DMARC). Idempotent on the node side.
func (s *Server) handleGenerateDKIM(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req generateDKIMRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	domain := strings.ToLower(strings.TrimSpace(req.Domain))
	if domain == "" || !strings.Contains(domain, ".") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid mail domain is required")
		return
	}
	selector := strings.TrimSpace(req.Selector)
	if selector == "" {
		selector = "mail"
	}

	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusConflict, "no_node", "no node available")
		return
	}

	res, err := s.runAwaitedJob(ctx, p, jobs.TypeMailDKIMGenerate, node.ID, map[string]any{
		"domain": domain, "selector": selector,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "mail.dkim.generate", "domain", domain, audit.OutcomeSuccess, r,
		map[string]any{"selector": selector})
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}
