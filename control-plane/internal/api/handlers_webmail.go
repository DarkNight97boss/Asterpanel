package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

// mailboxCreds resolves a mailbox's address and decrypts its stored password so
// the gateway can authenticate to IMAP/SMTP on the user's behalf.
func (s *Server) mailboxCreds(ctx context.Context, orgID, mailboxID uuid.UUID) (address, password string, err error) {
	address, secretID, err := s.deps.Store.GetMailboxAuth(ctx, orgID, mailboxID)
	if err != nil {
		return "", "", err
	}
	if !secretID.Valid {
		return "", "", errors.New("mailbox has no stored credentials")
	}
	ct, nonce, _, err := s.deps.Store.GetSecretByID(ctx, secretID.UUID)
	if err != nil {
		return "", "", err
	}
	pw, err := s.deps.Envelope.Decrypt(ct, nonce, []byte("mailbox:"+mailboxID.String()))
	if err != nil {
		return "", "", err
	}
	return address, string(pw), nil
}

// webmailSession validates config + resolves creds; writes the error response
// and returns ok=false if anything fails.
func (s *Server) webmailSession(w http.ResponseWriter, r *http.Request) (mailboxID uuid.UUID, addr, pass string, ok bool) {
	if s.deps.Webmail == nil || !s.deps.Webmail.Configured() {
		httpx.Error(w, http.StatusServiceUnavailable, "webmail_unavailable", "no mail server configured")
		return uuid.Nil, "", "", false
	}
	id, err := uuid.Parse(chi.URLParam(r, "mailboxID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid mailbox id")
		return uuid.Nil, "", "", false
	}
	p := middleware.PrincipalFrom(r.Context())
	addr, pass, err = s.mailboxCreds(r.Context(), p.OrgID, id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "mailbox not found")
		return uuid.Nil, "", "", false
	}
	return id, addr, pass, true
}

func (s *Server) handleWebmailFolders(w http.ResponseWriter, r *http.Request) {
	_, addr, pass, ok := s.webmailSession(w, r)
	if !ok {
		return
	}
	folders, err := s.deps.Webmail.Folders(addr, pass)
	if err != nil {
		httpx.Error(w, http.StatusBadGateway, "imap_error", "mail server error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"folders": folders})
}

func (s *Server) handleWebmailMessages(w http.ResponseWriter, r *http.Request) {
	_, addr, pass, ok := s.webmailSession(w, r)
	if !ok {
		return
	}
	folder := r.URL.Query().Get("folder")
	if folder == "" {
		folder = "INBOX"
	}
	limit := uint32(50)
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 32); err == nil && n > 0 && n <= 200 {
			limit = uint32(n)
		}
	}
	msgs, err := s.deps.Webmail.Messages(addr, pass, folder, limit)
	if err != nil {
		httpx.Error(w, http.StatusBadGateway, "imap_error", "mail server error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

func (s *Server) handleWebmailMessage(w http.ResponseWriter, r *http.Request) {
	_, addr, pass, ok := s.webmailSession(w, r)
	if !ok {
		return
	}
	uid64, err := strconv.ParseUint(chi.URLParam(r, "uid"), 10, 32)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid uid")
		return
	}
	folder := r.URL.Query().Get("folder")
	if folder == "" {
		folder = "INBOX"
	}
	msg, err := s.deps.Webmail.Message(addr, pass, folder, uint32(uid64))
	if err != nil {
		httpx.Error(w, http.StatusBadGateway, "imap_error", "mail server error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"message": msg})
}

type webmailSendRequest struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

func (s *Server) handleWebmailSend(w http.ResponseWriter, r *http.Request) {
	mailboxID, addr, pass, ok := s.webmailSession(w, r)
	if !ok {
		return
	}
	var req webmailSendRequest
	if err := httpx.Decode(w, r, &req); err != nil || !strings.Contains(req.To, "@") {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a valid recipient is required")
		return
	}
	if err := s.deps.Webmail.Send(addr, pass, addr, req.To, req.Subject, req.Body); err != nil {
		httpx.Error(w, http.StatusBadGateway, "smtp_error", "could not send message")
		return
	}
	p := middleware.PrincipalFrom(r.Context())
	org := p.OrgID
	s.audit(r.Context(), &org, &p.UserID, "email.send", "mailbox", mailboxID.String(), audit.OutcomeSuccess, r,
		map[string]any{"to": req.To})
	httpx.JSON(w, http.StatusAccepted, map[string]any{"sent": true})
}
