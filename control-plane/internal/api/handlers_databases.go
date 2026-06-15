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

var validDBEngines = map[string]bool{
	"postgres": true, "mysql": true, "mariadb": true, "redis": true, "mongodb": true,
}

func dbDefaultPort(engine string) int {
	switch engine {
	case "mysql", "mariadb":
		return 3306
	case "redis":
		return 6379
	case "mongodb":
		return 27017
	default:
		return 5432
	}
}

func dbDefaultVersion(engine string) string {
	switch engine {
	case "mysql":
		return "8.0"
	case "mariadb":
		return "11"
	case "redis":
		return "7"
	case "mongodb":
		return "7"
	default:
		return "16"
	}
}

func databaseView(d store.DatabaseInstance) map[string]any {
	return map[string]any{
		"id":         d.ID,
		"engine":     d.Engine,
		"version":    d.Version,
		"name":       d.Name,
		"db_user":    d.DBUser,
		"host":       d.Host,
		"port":       d.Port,
		"status":     d.Status,
		"size_mb":    d.SizeMB,
		"created_at": d.CreatedAt,
	}
}

func (s *Server) handleListDatabases(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbs, err := s.deps.Store.ListDatabaseInstances(ctx, p.OrgID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list databases")
		return
	}
	views := make([]map[string]any, 0, len(dbs))
	for _, d := range dbs {
		views = append(views, databaseView(d))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"databases": views})
}

type createDatabaseRequest struct {
	Engine string `json:"engine"`
	Name   string `json:"name"`
	NodeID string `json:"node_id"`
}

// handleCreateDatabase provisions a managed database: it generates a strong
// password, stores it envelope-encrypted, persists the instance, and dispatches
// a signed `database.create` job to the node agent. The password is returned to
// the caller exactly once and never persisted in plaintext.
func (s *Server) handleCreateDatabase(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)

	var req createDatabaseRequest
	if err := httpx.Decode(w, r, &req); err != nil || !validDBEngines[req.Engine] || strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "engine (postgres|mysql|mariadb|redis|mongodb) and name are required")
		return
	}

	// Resolve the target node: explicit, or auto-place on the first available.
	var node *store.ServerNode
	if strings.TrimSpace(req.NodeID) != "" {
		nid, perr := uuid.Parse(req.NodeID)
		if perr != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid node_id")
			return
		}
		n, gerr := s.deps.Store.GetNode(ctx, p.OrgID, nid)
		if gerr != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "node not found")
			return
		}
		node = n
	} else {
		nodes, lerr := s.deps.Store.ListNodes(ctx, p.OrgID)
		if lerr != nil || len(nodes) == 0 {
			httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available — register one first")
			return
		}
		node = &nodes[0]
	}

	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeDatabaseCreate, node.ID); !ok {
		org := p.OrgID
		s.audit(ctx, &org, &p.UserID, "database.create", "database_instance", "", audit.OutcomeDenied, r, map[string]any{"reason": reason})
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	// Generate + seal credentials.
	password, err := crypto.RandomHex(18)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate password")
		return
	}
	dbID := uuid.New()
	dbUser := req.Name
	aad := []byte("database:" + dbID.String())
	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(password), aad)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal credentials")
		return
	}
	secretID, err := s.deps.Store.CreateSecret(ctx, p.OrgID, uuid.NullUUID{}, "database:"+dbID.String(), ct, nonce, s.deps.Envelope.KeyID())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store credentials")
		return
	}

	port := dbDefaultPort(req.Engine)
	version := dbDefaultVersion(req.Engine)
	db, err := s.deps.Store.CreateDatabaseInstance(ctx, store.CreateDatabaseParams{
		ID:                  dbID,
		OrgID:               p.OrgID,
		NodeID:              uuid.NullUUID{UUID: node.ID, Valid: true},
		Engine:              req.Engine,
		Version:             version,
		Name:                req.Name,
		DBUser:              dbUser,
		Host:                node.Hostname,
		Port:                port,
		CredentialsSecretID: uuid.NullUUID{UUID: secretID, Valid: true},
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create database (name may already exist)")
		return
	}

	payload := map[string]any{
		"database_id": dbID,
		"engine":      req.Engine,
		"version":     version,
		"name":        req.Name,
		"db_user":     dbUser,
		"password":    password, // redacted before persistence; sent only over signed mTLS body
		"port":        port,
	}
	jobID, dispatched, jerr := s.signPersistDispatch(ctx, p, jobs.TypeDatabaseCreate, node.ID, payload)
	if jerr != nil {
		s.deps.Log.Error("database job error", "error", jerr)
	}

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "database.create", "database_instance", dbID.String(), audit.OutcomeSuccess, r,
		map[string]any{"engine": req.Engine, "job_id": jobID.String()})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"database":    databaseView(*db),
		"credentials": map[string]any{"user": dbUser, "password": password},
		"job":         map[string]any{"id": jobID, "dispatched": dispatched},
	})
}
