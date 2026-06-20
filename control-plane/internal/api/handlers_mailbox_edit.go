package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

func mailboxAAD(id uuid.UUID) []byte { return []byte("mailbox:" + id.String()) }

var validMailboxStatuses = map[string]bool{"active": true, "suspended": true}

// applyMailboxes re-renders the org's full mailbox set (Dovecot passwd-file +
// Postfix virtual map) on the node. Each mailbox's password is decrypted from its
// secret so a quota / status / password change becomes one declarative re-render.
func (s *Server) applyMailboxes(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	boxes, err := s.deps.Store.MailboxesForApply(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeMailboxApply, node.ID); !ok {
		return uuid.Nil, false
	}
	list := make([]map[string]any, 0, len(boxes))
	for _, b := range boxes {
		password := ""
		if b.SecretID.Valid {
			if ct, nonce, _, gerr := s.deps.Store.GetSecretByID(ctx, b.SecretID.UUID); gerr == nil {
				if dec, derr := s.deps.Envelope.Decrypt(ct, nonce, mailboxAAD(b.ID)); derr == nil {
					password = string(dec)
				}
			}
		}
		list = append(list, map[string]any{
			"address": b.Address, "password": password,
			"quota_mb": b.QuotaMB, "active": b.Status == "active",
		})
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeMailboxApply, node.ID, map[string]any{"mailboxes": list})
	return jobID, dispatched
}

type updateMailboxRequest struct {
	QuotaMB int    `json:"quota_mb"`
	Status  string `json:"status"`
}

// handleUpdateMailbox changes a mailbox's quota and/or status (active /
// suspended) and re-applies the mail config.
func (s *Server) handleUpdateMailbox(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "mailboxID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid mailbox id")
		return
	}
	var req updateMailboxRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "active"
	}
	if !validMailboxStatuses[status] {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "status must be active or suspended")
		return
	}
	mb, err := s.deps.Store.UpdateMailbox(ctx, p.OrgID, id, req.QuotaMB, status)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "mailbox not found")
		return
	}
	jobID, dispatched := s.applyMailboxes(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.mailbox.update", "mailbox", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"status": status, "quota_mb": mb.QuotaMB, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"mailbox":  mailboxView(*mb),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

// handleResetMailboxPassword generates a new password, re-seals the mailbox's
// secret and re-applies the mail config. The new password is returned once.
func (s *Server) handleResetMailboxPassword(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "mailboxID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid mailbox id")
		return
	}
	address, secretID, err := s.deps.Store.GetMailboxAuth(ctx, p.OrgID, id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "mailbox not found")
		return
	}
	if !secretID.Valid {
		httpx.Error(w, http.StatusConflict, "no_secret", "mailbox has no stored credentials")
		return
	}
	password, err := crypto.RandomHex(16)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate password")
		return
	}
	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(password), mailboxAAD(id))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal password")
		return
	}
	if err := s.deps.Store.UpdateSecretByID(ctx, secretID.UUID, ct, nonce, s.deps.Envelope.KeyID()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store password")
		return
	}
	jobID, dispatched := s.applyMailboxes(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.mailbox.password", "mailbox", id.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"address":  address,
		"password": password,
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}
