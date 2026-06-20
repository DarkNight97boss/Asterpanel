package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
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

var sshKeyTypes = map[string]bool{
	"ssh-ed25519":                       true,
	"ssh-rsa":                           true,
	"ecdsa-sha2-nistp256":               true,
	"ecdsa-sha2-nistp384":               true,
	"ecdsa-sha2-nistp521":               true,
	"sk-ssh-ed25519@openssh.com":        true,
	"sk-ecdsa-sha2-nistp256@openssh.com": true,
}

// parseSSHPublicKey validates a single-line OpenSSH public key (`<type> <base64>
// [comment]`, no options/command) and returns its type + SHA256 fingerprint.
func parseSSHPublicKey(s string) (keyType, fingerprint string, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" || strings.ContainsAny(s, "\n\r") {
		return "", "", false
	}
	fields := strings.Fields(s)
	if len(fields) < 2 || len(fields) > 3 || !sshKeyTypes[fields[0]] {
		return "", "", false
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(blob) < 12 {
		return "", "", false
	}
	sum := sha256.Sum256(blob)
	fp := "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "=")
	return fields[0], fp, true
}

func sshKeyView(k store.SSHKey) map[string]any {
	return map[string]any{
		"id": k.ID, "name": k.Name, "key_type": k.KeyType,
		"fingerprint": k.Fingerprint, "created_at": k.CreatedAt,
	}
}

func (s *Server) handleListSSHKeys(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	items, err := s.deps.Store.ListSSHKeys(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list keys")
		return
	}
	views := make([]map[string]any, 0, len(items))
	for _, k := range items {
		views = append(views, sshKeyView(k))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"keys": views})
}

type createSSHKeyRequest struct {
	Name      string `json:"name"`
	PublicKey string `json:"public_key"`
}

// handleCreateSSHKey registers an authorized public key and re-applies the org's
// authorized_keys file on the node.
func (s *Server) handleCreateSSHKey(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	var req createSSHKeyRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a name is required")
		return
	}
	pub := strings.TrimSpace(req.PublicKey)
	keyType, fingerprint, ok := parseSSHPublicKey(pub)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "not a valid OpenSSH public key")
		return
	}
	k, err := s.deps.Store.CreateSSHKey(ctx, store.CreateSSHKeyParams{
		OrgID: p.OrgID, Name: strings.TrimSpace(req.Name), KeyType: keyType, PublicKey: pub, Fingerprint: fingerprint,
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not add key (already authorized?)")
		return
	}
	jobID, dispatched := s.applySSHKeys(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "ssh.key.add", "ssh_key", k.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"fingerprint": fingerprint, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"key":      sshKeyView(*k),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

type renameSSHKeyRequest struct {
	Name string `json:"name"`
}

// handleRenameSSHKey changes a key's display name and re-applies the authorized
// keys file (the public key itself is immutable).
func (s *Server) handleRenameSSHKey(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "keyID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	var req renameSSHKeyRequest
	if err := httpx.Decode(w, r, &req); err != nil || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a name is required")
		return
	}
	k, err := s.deps.Store.RenameSSHKey(ctx, p.OrgID, id, strings.TrimSpace(req.Name))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "key not found")
		return
	}
	jobID, dispatched := s.applySSHKeys(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "ssh.key.rename", "ssh_key", k.ID.String(), audit.OutcomeSuccess, r,
		map[string]any{"name": k.Name, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"key":      sshKeyView(*k),
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

func (s *Server) handleDeleteSSHKey(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	id, err := uuid.Parse(chi.URLParam(r, "keyID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid id")
		return
	}
	if err := s.deps.Store.DeleteSSHKey(ctx, p.OrgID, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete")
		return
	}
	s.applySSHKeys(ctx, p)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "ssh.key.remove", "ssh_key", id.String(), audit.OutcomeSuccess, r, nil)
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applySSHKeys renders the org's authorized keys and dispatches ssh.keys.apply so
// the agent rewrites the authorized_keys file.
func (s *Server) applySSHKeys(ctx context.Context, p *middleware.Principal) (uuid.UUID, bool) {
	items, err := s.deps.Store.ListSSHKeys(ctx, p.OrgID)
	if err != nil {
		return uuid.Nil, false
	}
	node := s.firstNode(ctx, p.OrgID)
	if node == nil {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeSSHKeysApply, node.ID); !ok {
		return uuid.Nil, false
	}
	keys := make([]string, 0, len(items))
	for _, k := range items {
		keys = append(keys, k.PublicKey)
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeSSHKeysApply, node.ID, map[string]any{"keys": keys})
	return jobID, dispatched
}
