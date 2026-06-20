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

	if over, used, limit := s.overQuota(ctx, p.OrgID, "databases"); over {
		httpx.ErrorWithDetails(w, http.StatusForbidden, "quota_exceeded", "plan database limit reached",
			map[string]any{"used": used, "limit": limit})
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

// validDBPrivileges is the privilege allowlist, mirrored by the agent's renderer
// so a grant can never carry arbitrary SQL.
var validDBPrivileges = map[string]bool{
	"ALL": true, "SELECT": true, "INSERT": true, "UPDATE": true, "DELETE": true,
	"CREATE": true, "DROP": true, "ALTER": true, "INDEX": true, "EXECUTE": true, "REFERENCES": true,
}

func validDBUsername(s string) bool {
	if len(s) == 0 || len(s) > 32 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

// normalizePrivileges upper-cases, de-dupes and validates a privilege list.
// Empty defaults to ["ALL"]; "ALL" collapses the set; an unknown token is rejected.
func normalizePrivileges(in []string) ([]string, bool) {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, p := range in {
		t := strings.ToUpper(strings.TrimSpace(p))
		if t == "" {
			continue
		}
		if !validDBPrivileges[t] {
			return nil, false
		}
		if t == "ALL" {
			return []string{"ALL"}, true
		}
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return []string{"ALL"}, true
	}
	return out, true
}

func dbUserView(u store.DBUser) map[string]any {
	return map[string]any{
		"id":         u.ID,
		"username":   u.Username,
		"host":       u.HostScope,
		"privileges": u.Privileges,
		"created_at": u.CreatedAt,
	}
}

func (s *Server) handleListDBUsers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbID, err := uuid.Parse(chi.URLParam(r, "dbID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid database id")
		return
	}
	users, err := s.deps.Store.ListDBUsers(ctx, p.OrgID, dbID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not list users")
		return
	}
	views := make([]map[string]any, 0, len(users))
	for _, u := range users {
		views = append(views, dbUserView(u))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"users": views})
}

type createDBUserRequest struct {
	Username   string   `json:"username"`
	Host       string   `json:"host"`
	Privileges []string `json:"privileges"`
}

// handleCreateDBUser creates a named login role on a database, sealing its
// generated password and dispatching a database.user.create job (CREATE USER +
// GRANT, run inside the DB container). The password is returned exactly once.
func (s *Server) handleCreateDBUser(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbID, err := uuid.Parse(chi.URLParam(r, "dbID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid database id")
		return
	}
	var req createDBUserRequest
	if e := httpx.Decode(w, r, &req); e != nil || !validDBUsername(strings.TrimSpace(req.Username)) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "username must be 1–32 chars (letters, digits, underscore)")
		return
	}
	privs, ok := normalizePrivileges(req.Privileges)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "unknown privilege")
		return
	}
	host := strings.TrimSpace(req.Host)
	if host == "" {
		host = "%"
	}
	db, err := s.deps.Store.GetDatabaseInstance(ctx, p.OrgID, dbID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "database not found")
		return
	}
	nodeID := uuid.Nil
	if db.ServerNodeID.Valid {
		nodeID = db.ServerNodeID.UUID
	} else if n := s.firstNode(ctx, p.OrgID); n != nil {
		nodeID = n.ID
	}
	if nodeID == uuid.Nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeDatabaseUser, nodeID); !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	// Generate + seal the user's password (AAD scoped to the new user id).
	password, err := crypto.RandomHex(16)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate password")
		return
	}
	userID := uuid.New()
	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(password), []byte("database_user:"+userID.String()))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal credentials")
		return
	}
	secretID, err := s.deps.Store.CreateSecret(ctx, p.OrgID, uuid.NullUUID{}, "database_user:"+userID.String(), ct, nonce, s.deps.Envelope.KeyID())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store credentials")
		return
	}
	u, err := s.deps.Store.CreateDBUser(ctx, store.CreateDBUserParams{
		ID:                  userID,
		OrgID:               p.OrgID,
		DatabaseID:          dbID,
		Username:            strings.TrimSpace(req.Username),
		HostScope:           host,
		Privileges:          privs,
		CredentialsSecretID: uuid.NullUUID{UUID: secretID, Valid: true},
	})
	if err != nil {
		httpx.Error(w, http.StatusConflict, "create_failed", "could not create user (name may already exist)")
		return
	}

	owner := db.Name
	if db.DBUser != nil && *db.DBUser != "" {
		owner = *db.DBUser
	}
	payload := map[string]any{
		"database_id": dbID, "engine": db.Engine, "database": db.Name, "owner": owner,
		"username": u.Username, "host": host, "privileges": privs, "password": password,
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeDatabaseUser, nodeID, payload)

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "database.user.create", "database_instance", dbID.String(), audit.OutcomeSuccess, r,
		map[string]any{"username": u.Username, "job_id": jobID.String()})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"user":     dbUserView(*u),
		"password": password,
		"job":      map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

// handleResetDBUserPassword generates a fresh password for an existing database
// user, re-seals it under the same AAD/secret, and dispatches a signed
// database.user.password job so the agent runs ALTER USER/ROLE in the container.
func (s *Server) handleResetDBUserPassword(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbID, err := uuid.Parse(chi.URLParam(r, "dbID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid database id")
		return
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid user id")
		return
	}
	u, err := s.deps.Store.GetDBUser(ctx, p.OrgID, userID)
	if err != nil || u.DatabaseID != dbID {
		httpx.Error(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	if !u.CredentialsSecretID.Valid {
		httpx.Error(w, http.StatusConflict, "no_secret", "user has no stored credentials")
		return
	}
	db, err := s.deps.Store.GetDatabaseInstance(ctx, p.OrgID, dbID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "database not found")
		return
	}
	nodeID := uuid.Nil
	if db.ServerNodeID.Valid {
		nodeID = db.ServerNodeID.UUID
	} else if n := s.firstNode(ctx, p.OrgID); n != nil {
		nodeID = n.ID
	}
	if nodeID == uuid.Nil {
		httpx.Error(w, http.StatusBadRequest, "no_nodes", "no node available")
		return
	}
	if ok, reason := s.jobPolicyAllows(ctx, p, jobs.TypeDatabaseUserPass, nodeID); !ok {
		httpx.Error(w, http.StatusForbidden, "forbidden", "job denied by policy: "+reason)
		return
	}

	password, err := crypto.RandomHex(16)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not generate password")
		return
	}
	ct, nonce, err := s.deps.Envelope.Encrypt([]byte(password), []byte("database_user:"+userID.String()))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not seal credentials")
		return
	}
	if err := s.deps.Store.UpdateSecretByID(ctx, u.CredentialsSecretID.UUID, ct, nonce, s.deps.Envelope.KeyID()); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not store credentials")
		return
	}

	owner := db.Name
	if db.DBUser != nil && *db.DBUser != "" {
		owner = *db.DBUser
	}
	payload := map[string]any{
		"database_id": dbID, "engine": db.Engine, "database": db.Name, "owner": owner,
		"username": u.Username, "host": u.HostScope, "password": password,
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeDatabaseUserPass, nodeID, payload)

	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "database.user.password", "database_instance", dbID.String(), audit.OutcomeSuccess, r,
		map[string]any{"username": u.Username, "job_id": jobID.String()})

	httpx.JSON(w, http.StatusOK, map[string]any{
		"user":     dbUserView(*u),
		"password": password,
		"job":      map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

type setDBUserPrivilegesRequest struct {
	Privileges []string `json:"privileges"`
}

// handleSetDBUserPrivileges re-applies a DB user's grants (REVOKE ALL + GRANT the
// new set) via a database.user.privileges job and records the new set.
func (s *Server) handleSetDBUserPrivileges(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbID, err := uuid.Parse(chi.URLParam(r, "dbID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid database id")
		return
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid user id")
		return
	}
	var req setDBUserPrivilegesRequest
	if e := httpx.Decode(w, r, &req); e != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	privs, ok := normalizePrivileges(req.Privileges)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "unknown privilege")
		return
	}
	db, err := s.deps.Store.GetDatabaseInstance(ctx, p.OrgID, dbID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "database not found")
		return
	}
	u, err := s.deps.Store.GetDBUser(ctx, p.OrgID, userID)
	if err != nil || u.DatabaseID != dbID {
		httpx.Error(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	if err := s.deps.Store.UpdateDBUserPrivileges(ctx, p.OrgID, userID, privs); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not update privileges")
		return
	}
	jobID, dispatched := s.applyDBUserGrant(ctx, p, db, u, privs)
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "database.user.privileges", "database_instance", dbID.String(), audit.OutcomeSuccess, r,
		map[string]any{"username": u.Username, "privileges": privs, "job_id": jobID.String()})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"user":     map[string]any{"id": u.ID, "username": u.Username, "host": u.HostScope, "privileges": privs},
		"dispatch": map[string]any{"id": jobID, "dispatched": dispatched},
	})
}

// handleDeleteDBUser dispatches a database.user.delete job (DROP USER) and removes the row.
func (s *Server) handleDeleteDBUser(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbID, err := uuid.Parse(chi.URLParam(r, "dbID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid database id")
		return
	}
	userID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid user id")
		return
	}
	db, err := s.deps.Store.GetDatabaseInstance(ctx, p.OrgID, dbID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "database not found")
		return
	}
	u, err := s.deps.Store.GetDBUser(ctx, p.OrgID, userID)
	if err != nil || u.DatabaseID != dbID {
		httpx.Error(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	if db.ServerNodeID.Valid {
		if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeDatabaseUserDrop, db.ServerNodeID.UUID); ok {
			owner := db.Name
			if db.DBUser != nil && *db.DBUser != "" {
				owner = *db.DBUser
			}
			s.signPersistDispatch(ctx, p, jobs.TypeDatabaseUserDrop, db.ServerNodeID.UUID, map[string]any{
				"database_id": dbID, "engine": db.Engine, "database": db.Name, "owner": owner,
				"username": u.Username, "host": u.HostScope,
			})
		}
	}
	if err := s.deps.Store.DeleteDBUser(ctx, p.OrgID, userID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "could not delete user")
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "database.user.delete", "database_instance", dbID.String(), audit.OutcomeSuccess, r,
		map[string]any{"username": u.Username})
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// applyDBUserGrant dispatches a database.user.privileges job to re-apply a user's grants.
func (s *Server) applyDBUserGrant(ctx context.Context, p *middleware.Principal, db *store.DatabaseInstance, u *store.DBUser, privs []string) (uuid.UUID, bool) {
	if !db.ServerNodeID.Valid {
		return uuid.Nil, false
	}
	if ok, _ := s.jobPolicyAllows(ctx, p, jobs.TypeDatabaseUserGrant, db.ServerNodeID.UUID); !ok {
		return uuid.Nil, false
	}
	owner := db.Name
	if db.DBUser != nil && *db.DBUser != "" {
		owner = *db.DBUser
	}
	jobID, dispatched, _ := s.signPersistDispatch(ctx, p, jobs.TypeDatabaseUserGrant, db.ServerNodeID.UUID, map[string]any{
		"database_id": db.ID, "engine": db.Engine, "database": db.Name, "owner": owner,
		"username": u.Username, "host": u.HostScope, "privileges": privs,
	})
	return jobID, dispatched
}

type databaseQueryRequest struct {
	SQL     string `json:"sql"`
	MaxRows int    `json:"max_rows"`
}

// handleDatabaseQuery runs an ad-hoc SQL statement inside the database container
// and returns the result set — a built-in phpMyAdmin-style query runner. The
// statement targets the tenant's own database (tenant-bound); the agent enforces
// a statement timeout and the control plane caps the rows returned. Only the
// engine is audited, never the SQL text (it can carry secrets).
func (s *Server) handleDatabaseQuery(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := middleware.PrincipalFrom(ctx)
	dbID, err := uuid.Parse(chi.URLParam(r, "dbID"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid database id")
		return
	}
	db, err := s.deps.Store.GetDatabaseInstance(ctx, p.OrgID, dbID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "database not found")
		return
	}
	if !db.ServerNodeID.Valid {
		httpx.Error(w, http.StatusConflict, "no_node", "database has no node")
		return
	}
	var req databaseQueryRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "invalid request body")
		return
	}
	sql := strings.TrimSpace(req.SQL)
	if sql == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "a SQL statement is required")
		return
	}
	maxRows := req.MaxRows
	if maxRows <= 0 || maxRows > 5000 {
		maxRows = 1000
	}
	owner := db.Name
	if db.DBUser != nil && *db.DBUser != "" {
		owner = *db.DBUser
	}
	res, err := s.runAwaitedJob(ctx, p, jobs.TypeDatabaseQuery, db.ServerNodeID.UUID, map[string]any{
		"database_id": db.ID, "engine": db.Engine, "database": db.Name,
		"owner": owner, "sql": sql, "max_rows": maxRows,
	})
	if err != nil {
		fileJobError(w, err)
		return
	}
	org := p.OrgID
	s.audit(ctx, &org, &p.UserID, "database.query", "database_instance", dbID.String(), audit.OutcomeSuccess, r,
		map[string]any{"engine": db.Engine})
	httpx.JSON(w, http.StatusOK, rawOrEmpty(res))
}
