package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/crypto"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/store"
)

func ftpView(a store.FtpAccount) map[string]any {
	return map[string]any{
		"id":             a.ID,
		"username":       a.Username,
		"protocol":       a.Protocol,
		"home_directory": a.HomeDirectory,
		"website":        nil,
		"status":         a.Status,
		"created_at":     a.CreatedAt,
	}
}

func (s *Server) handleListFtp(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	accts, err := s.deps.Store.ListFtpAccounts(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list accounts")
		return
	}
	views := make([]map[string]any, 0, len(accts))
	for _, a := range accts {
		views = append(views, ftpView(a))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"accounts": views})
}

type createFtpRequest struct {
	Username      string `json:"username"`
	Protocol      string `json:"protocol"`
	HomeDirectory string `json:"home_directory"`
}

func (s *Server) handleCreateFtp(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createFtpRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Username) == "" || strings.TrimSpace(req.HomeDirectory) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "username and home_directory are required")
		return
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeFTPAccountCreate, node.ID); !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	password, err := crypto.RandomHex(16)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate password")
		return
	}
	ftpID := uuid.New()
	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(password), []byte("ftp:"+ftpID.String()))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal password")
		return
	}
	secretID, err := s.deps.Store.CreateSecret(ctx, p.OrgID, uuid.NullUUID{}, "ftp:"+ftpID.String(), ct, nonce, s.deps.Envelope.KeyID())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store credentials")
		return
	}

	protocol := req.Protocol
	if protocol == "" {
		protocol = "SFTP"
	}
	acct, err := s.deps.Store.CreateFtpAccount(ctx, store.CreateFtpParams{
		ID: ftpID, OrgID: p.OrgID, NodeID: uuid.NullUUID{UUID: node.ID, Valid: true},
		Username: req.Username, Protocol: protocol, HomeDirectory: req.HomeDirectory,
		CredentialsSecretID: uuid.NullUUID{UUID: secretID, Valid: true},
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create account (username taken?)")
		return
	}

	payload := map[string]any{
		"ftp_id":         ftpID,
		"username":       req.Username,
		"password":       password,
		"home_directory": req.HomeDirectory,
		"protocol":       protocol,
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeFTPAccountCreate, node.ID, payload)

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "ftp.create", "ftp_account", ftpID.String(), audit.OutcomeSuccess, r,
		map[string]any{"username": req.Username, "job_id": jobID.String()})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"account":  ftpView(*acct),
		"password": password,
		"job":      map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteFtp(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "ftpID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteFtpAccount(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "ftp.delete", "ftp_account", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}
