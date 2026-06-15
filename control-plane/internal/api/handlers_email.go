package api

import (
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func mailboxView(m store.Mailbox) map[string]any {
	return map[string]any{
		"id":       m.ID,
		"address":  m.Address,
		"quota_mb": m.QuotaMB,
		"used_mb":  m.UsedMB,
		"status":   m.Status,
	}
}

func (s *Server) handleListMailboxes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	boxes, err := s.deps.Store.ListMailboxes(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list mailboxes")
		return
	}
	views := make([]map[string]any, 0, len(boxes))
	for _, m := range boxes {
		views = append(views, mailboxView(m))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"mailboxes": views})
}

type createMailboxRequest struct {
	Address string `json:"address"`
	QuotaMB int    `json:"quota_mb"`
}

// handleCreateMailbox provisions an IMAP/SMTP mailbox: generates a password,
// seals it, persists the mailbox, and dispatches a signed mail.mailbox.create
// job so the agent writes the Dovecot/Postfix config. Password shown once.
func (s *Server) handleCreateMailbox(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createMailboxRequest
	if err := httpx.Decode(w, r, &req); err != nil || !strings.Contains(req.Address, "@") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid email address is required")
		return
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeMailboxCreate, node.ID); !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	password, err := crypto.RandomHex(16)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate password")
		return
	}
	mbID := uuid.New()
	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(password), []byte("mailbox:"+mbID.String()))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal password")
		return
	}
	secretID, err := s.deps.Store.CreateSecret(ctx, p.OrgID, uuid.NullUUID{}, "mailbox:"+mbID.String(), ct, nonce, s.deps.Envelope.KeyID())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store credentials")
		return
	}

	mb, err := s.deps.Store.CreateMailbox(ctx, store.CreateMailboxParams{
		ID: mbID, OrgID: p.OrgID, NodeID: uuid.NullUUID{UUID: node.ID, Valid: true},
		Address: strings.ToLower(req.Address), QuotaMB: req.QuotaMB,
		CredentialsSecretID: uuid.NullUUID{UUID: secretID, Valid: true},
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create mailbox (already exists?)")
		return
	}

	payload := map[string]any{
		"mailbox_id": mbID,
		"address":    mb.Address,
		"password":   password, // redacted before persistence; only in the signed body
		"quota_mb":   mb.QuotaMB,
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeMailboxCreate, node.ID, payload)

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.mailbox.create", "mailbox", mbID.String(), audit.OutcomeSuccess, r,
		map[string]any{"address": mb.Address, "job_id": jobID.String()})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"mailbox":  mailboxView(*mb),
		"password": password,
		"job":      map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

// handleEnsureMailServer dispatches a mail.server.ensure job so the node runs a
// Postfix+Dovecot container reading the config the mailbox executor writes.
func (s *Server) handleEnsureMailServer(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeMailServerEnsure, node.ID); !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeMailServerEnsure, node.ID,
		map[string]any{"mail_dir": "/etc/asterpanel/mail"})
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "email.server.ensure", "node", node.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"job_id": jobID.String()})
	httpx.JSON(w, http.StatusAccepted, map[string]any{"job": map[string]any{"id": jobID, "dispatched": dispatched}})
}
