package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/httpx"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/jobs"
	"github.com/DarkNight97boss/asterpanel/control-plane/internal/middleware"
)

// File-manager operations are signed, OPA-gated, audited jobs scoped to a single
// site's document root on the node. They run on the agent's hardened file API;
// the control plane never touches the node filesystem directly. Reads/lists are
// dispatched then briefly awaited so the UI keeps a simple synchronous contract.
const (
	maxWriteBytes = 5 << 20 // 5 MiB upload/write cap (enforced again on the node)
	jobWaitBudget = 8 * time.Second
	jobWaitTick   = 120 * time.Millisecond
)

var (
	errAgentUnavailable = errors.New("node agent unavailable")
	errAgentTimeout     = errors.New("timed out waiting for the node")
	errPolicyDenied     = errors.New("operation not permitted by policy")
)

// cleanRelPath normalizes a client-supplied path to a root-relative form that
// cannot escape the site root. path.Clean collapses any ".." so the result is
// always anchored at "/"; we then strip the leading slash. Returns false for
// NUL bytes (a classic truncation trick).
func cleanRelPath(p string) (string, bool) {
	if strings.ContainsRune(p, 0) {
		return "", false
	}
	if strings.TrimSpace(p) == "" {
		p = "/"
	}
	cleaned := path.Clean("/" + strings.TrimSpace(p))
	return strings.TrimPrefix(cleaned, "/"), true
}

// siteNode resolves a site id from the URL, verifies it belongs to the caller's
// org, and returns the node the site lives on.
func (s *Server) siteNode(ctx context.Context, orgID uuid.UUID, siteIDStr string) (uuid.UUID, uuid.UUID, error) {
	siteID, err := uuid.Parse(siteIDStr)
	if err != nil {
		return uuid.Nil, uuid.Nil, errors.New("invalid site id")
	}
	site, err := s.deps.Store.GetWebsite(ctx, orgID, siteID)
	if err != nil {
		return uuid.Nil, uuid.Nil, errors.New("site not found")
	}
	if !site.ServerNodeID.Valid {
		return uuid.Nil, uuid.Nil, errors.New("site has no node assigned")
	}
	return siteID, site.ServerNodeID.UUID, nil
}

// runAwaitedJob signs+dispatches an agent job and waits (bounded) for the
// callback to land the result in the jobs table, returning the raw outcome JSON.
// Shared by the read-style features (file manager, log tailing) that need a
// synchronous-looking result over the async job protocol.
func (s *Server) runAwaitedJob(ctx context.Context, p *middleware.Principal, typ jobs.Type, nodeID uuid.UUID, payload map[string]any) (json.RawMessage, error) {
	if ok, _ := s.jobPolicyAllows(ctx, p, typ, nodeID); !ok {
		return nil, errPolicyDenied
	}
	jobID, dispatched, err := s.signPersistDispatch(ctx, p, typ, nodeID, payload)
	if err != nil {
		return nil, err
	}
	if !dispatched {
		return nil, errAgentUnavailable
	}

	ticker := time.NewTicker(jobWaitTick)
	defer ticker.Stop()
	timeout := time.After(jobWaitBudget)
	for {
		if jr, gerr := s.deps.Store.GetJobResult(ctx, p.OrgID, jobID); gerr == nil {
			switch jr.Status {
			case "succeeded":
				return json.RawMessage(jr.Result), nil
			case "failed", "expired", "canceled":
				if jr.Error != nil && *jr.Error != "" {
					return nil, errors.New(*jr.Error)
				}
				return nil, errors.New("file operation failed on the node")
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timeout:
			return nil, errAgentTimeout
		case <-ticker.C:
		}
	}
}

// fileJobError maps the internal errors to HTTP responses.
func fileJobError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errPolicyDenied):
		httpx.Error(w, http.StatusForbidden, "policy_denied", err.Error())
	case errors.Is(err, errAgentUnavailable), errors.Is(err, errAgentTimeout):
		httpx.Error(w, http.StatusBadGateway, "node_unavailable", err.Error())
	default:
		httpx.Error(w, http.StatusBadRequest, "file_error", err.Error())
	}
}

func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, nodeID, err := s.siteNode(ctx, p.OrgID, chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	rel, ok := cleanRelPath(r.URL.Query().Get("path"))
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid path")
		return
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeFileList, nodeID, map[string]any{
		"site_id": siteID.String(), "path": rel,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}

func (s *Server) handleReadFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, nodeID, err := s.siteNode(ctx, p.OrgID, chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	rel, ok := cleanRelPath(r.URL.Query().Get("path"))
	if !ok || rel == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a file path is required")
		return
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeFileRead, nodeID, map[string]any{
		"site_id": siteID.String(), "path": rel,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}

type writeFileRequest struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"` // "utf8" (default) or "base64"
}

func (s *Server) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, nodeID, err := s.siteNode(ctx, p.OrgID, chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	var req writeFileRequest
	if derr := httpx.Decode(w, r, &req); derr != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	rel, ok := cleanRelPath(req.Path)
	if !ok || rel == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a file path is required")
		return
	}

	// Normalize content to base64 for transport; enforce the size cap on raw bytes.
	var b64 string
	switch req.Encoding {
	case "", "utf8", "utf-8", "text":
		if len(req.Content) > maxWriteBytes {
			httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large", "file exceeds 5 MiB limit")
			return
		}
		b64 = base64.StdEncoding.EncodeToString([]byte(req.Content))
	case "base64":
		raw, derr := base64.StdEncoding.DecodeString(req.Content)
		if derr != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid base64 content")
			return
		}
		if len(raw) > maxWriteBytes {
			httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large", "file exceeds 5 MiB limit")
			return
		}
		b64 = req.Content
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "unsupported encoding")
		return
	}

	res, err := s.runAwaitedJob(ctx, p, jobs.TypeFileWrite, nodeID, map[string]any{
		"site_id": siteID.String(), "path": rel, "content_b64": b64,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "file.write", "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"path": rel})
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}

type mkdirRequest struct {
	Path string `json:"path"`
}

func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, nodeID, err := s.siteNode(ctx, p.OrgID, chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	var req mkdirRequest
	if derr := httpx.Decode(w, r, &req); derr != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	rel, ok := cleanRelPath(req.Path)
	if !ok || rel == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a directory path is required")
		return
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeFileMkdir, nodeID, map[string]any{
		"site_id": siteID.String(), "path": rel,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "file.mkdir", "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"path": rel})
	httpx.JSON(w, http.StatusCreated, rawOrEmpty(res))
}

func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	siteID, nodeID, err := s.siteNode(ctx, p.OrgID, chi.URLParam(r, "siteID"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	rel, ok := cleanRelPath(r.URL.Query().Get("path"))
	if !ok || rel == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a path is required")
		return
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeFileDelete, nodeID, map[string]any{
		"site_id": siteID.String(), "path": rel,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "file.delete", "website", siteID.String(), audit.OutcomeSuccess, r,
		map[string]any{"path": rel})
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}

// rawOrEmpty turns the agent's raw JSON outcome into a value httpx.JSON can
// re-marshal, defaulting to {} when the agent returned null.
func rawOrEmpty(res json.RawMessage) any {
	var v any
	if len(res) == 0 || string(res) == "null" {
		return map[string]any{}
	}
	if err := json.Unmarshal(res, &v); err != nil {
		return map[string]any{}
	}
	return v
}
