package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/cloudflare"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

var errCloudflareNotConnected = errors.New("cloudflare not connected")

func cloudflareSecretAAD(orgID uuid.UUID) []byte { return []byte("cloudflare-token|" + orgID.String()) }

// cloudflareClient loads the org's stored token, decrypts it and returns a ready
// API client. Returns errCloudflareNotConnected when no token is configured.
func (s *Server) cloudflareClient(ctx context.Context, orgID uuid.UUID) (*cloudflare.Client, error) {
	acct, err := s.deps.Store.GetCloudflareAccount(ctx, orgID)
	if err != nil {
		return nil, errCloudflareNotConnected
	}
	token, err := s.deps.Envelope.Decrypt(acct.TokenCT, acct.TokenNonce, cloudflareSecretAAD(orgID))
	if err != nil {
		return nil, err
	}
	return cloudflare.New(string(token)), nil
}

func cloudflareError(w http.ResponseWriter, err error) {
	if errors.Is(err, errCloudflareNotConnected) {
		httpx.Error(w, http.StatusConflict, "not_connected", "connect a Cloudflare token first")
		return
	}
	httpx.Error(w, http.StatusBadGateway, "cloudflare_error", err.Error())
}

func (s *Server) handleGetCloudflare(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	acct, err := s.deps.Store.GetCloudflareAccount(ctx, p.OrgID)
	if err != nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"connected": false})
		return
	}
	var verified any
	if acct.VerifiedAt != nil {
		verified = *acct.VerifiedAt
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"connected": true, "label": acct.Label, "verified_at": verified, "created_at": acct.CreatedAt,
	})
}

type connectCloudflareRequest struct {
	Token string `json:"token"`
	Label string `json:"label"`
}

// handleConnectCloudflare verifies the supplied API token against Cloudflare and,
// only if it is valid, stores it envelope-encrypted.
func (s *Server) handleConnectCloudflare(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req connectCloudflareRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	if req.Token == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "an API token is required")
		return
	}

	// Verify before persisting — never store an invalid/unusable token.
	tv, err := cloudflare.New(req.Token).VerifyToken(ctx)
	if err != nil {
		httpx.Error(w, http.StatusBadGateway, "cloudflare_error", "token verification failed: "+err.Error())
		return
	}
	if tv.Status != "active" {
		httpx.Error(w, http.StatusBadRequest, "invalid_token", "token status is "+tv.Status)
		return
	}

	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(req.Token), cloudflareSecretAAD(p.OrgID))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal token")
		return
	}
	now := time.Now()
	acct, err := s.deps.Store.UpsertCloudflareAccount(ctx, store.UpsertCloudflareParams{
		OrgID: p.OrgID, Label: strings.TrimSpace(req.Label),
		TokenCT: ct, TokenNonce: nonce, TokenKeyID: s.deps.Envelope.KeyID(), VerifiedAt: &now,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not save Cloudflare connection")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "cloudflare.connect", "cloudflare_account", acct.ID.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"connected": true, "label": acct.Label, "verified_at": now})
}

func (s *Server) handleDisconnectCloudflare(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	if err := s.deps.Store.DeleteCloudflareAccount(ctx, p.OrgID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not disconnect")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "cloudflare.disconnect", "cloudflare_account", "", audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"connected": false})
}

func (s *Server) handleListCloudflareZones(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	cf, err := s.cloudflareClient(ctx, p.OrgID)
	if err != nil {
		cloudflareError(w, err)
		return
	}
	zones, err := cf.ListZones(ctx)
	if err != nil {
		cloudflareError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"zones": zones})
}

func (s *Server) handleListCloudflareDNS(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	cf, err := s.cloudflareClient(ctx, p.OrgID)
	if err != nil {
		cloudflareError(w, err)
		return
	}
	recs, err := cf.ListDNSRecords(ctx, chi.URLParam(r, "zoneID"))
	if err != nil {
		cloudflareError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"records": recs})
}

type createCloudflareDNSRequest struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
}

var validCFRecordTypes = map[string]bool{
	"A": true, "AAAA": true, "CNAME": true, "TXT": true, "MX": true, "NS": true, "CAA": true, "SRV": true,
}

func (s *Server) handleCreateCloudflareDNS(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createCloudflareDNSRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	req.Type = strings.ToUpper(strings.TrimSpace(req.Type))
	if !validCFRecordTypes[req.Type] || strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Content) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "type, name and content are required")
		return
	}
	cf, err := s.cloudflareClient(ctx, p.OrgID)
	if err != nil {
		cloudflareError(w, err)
		return
	}
	rec, err := cf.CreateDNSRecord(ctx, chi.URLParam(r, "zoneID"), cloudflare.DNSRecord{
		Type: req.Type, Name: strings.TrimSpace(req.Name), Content: strings.TrimSpace(req.Content), Proxied: req.Proxied,
	})
	if err != nil {
		cloudflareError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "cloudflare.dns.create", "cloudflare_account", chi.URLParam(r, "zoneID"), audit.OutcomeSuccess, r,
		map[string]any{"type": rec.Type, "name": rec.Name})
	httpx.JSON(w, http.StatusCreated, map[string]any{"record": rec})
}

func (s *Server) handleDeleteCloudflareDNS(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	cf, err := s.cloudflareClient(ctx, p.OrgID)
	if err != nil {
		cloudflareError(w, err)
		return
	}
	if err := cf.DeleteDNSRecord(ctx, chi.URLParam(r, "zoneID"), chi.URLParam(r, "recordID")); err != nil {
		cloudflareError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "cloudflare.dns.delete", "cloudflare_account", chi.URLParam(r, "recordID"), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Server) handlePurgeCloudflareCache(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	cf, err := s.cloudflareClient(ctx, p.OrgID)
	if err != nil {
		cloudflareError(w, err)
		return
	}
	zoneID := chi.URLParam(r, "zoneID")
	if err := cf.PurgeCache(ctx, zoneID); err != nil {
		cloudflareError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "cloudflare.cache.purge", "cloudflare_account", zoneID, audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"purged": true})
}
