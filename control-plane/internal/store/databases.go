package store

import (
	"context"

	"github.com/google/uuid"
)

// CreateSecret stores an envelope-encrypted value (e.g. database credentials).
func (s *Store) CreateSecret(ctx context.Context, orgID uuid.UUID, appID uuid.NullUUID, key string, ciphertext, nonce []byte, keyID string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO secrets (organization_id, application_id, key, ciphertext, nonce, key_id)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id`,
		orgID, appID, key, ciphertext, nonce, keyID).Scan(&id)
	return id, err
}

type CreateDatabaseParams struct {
	ID                  uuid.UUID
	OrgID               uuid.UUID
	NodeID              uuid.NullUUID
	Engine              string
	Version             string
	Name                string
	DBUser              string
	Host                string
	Port                int
	CredentialsSecretID uuid.NullUUID
}

func (s *Store) CreateDatabaseInstance(ctx context.Context, p CreateDatabaseParams) (*DatabaseInstance, error) {
	const q = `
		INSERT INTO database_instances
		    (id, organization_id, server_node_id, engine, version, name, db_user,
		     credentials_secret_id, host, port, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'provisioning')
		RETURNING id, organization_id, application_id, server_node_id, engine, version, name,
		          db_user, credentials_secret_id, host, port, status, size_mb, created_at`
	return scanDatabase(s.pool.QueryRow(ctx, q,
		p.ID, p.OrgID, p.NodeID, p.Engine, p.Version, p.Name, p.DBUser,
		p.CredentialsSecretID, p.Host, p.Port))
}

func (s *Store) GetDatabaseInstance(ctx context.Context, orgID, id uuid.UUID) (*DatabaseInstance, error) {
	const q = `
		SELECT id, organization_id, application_id, server_node_id, engine, version, name,
		       db_user, credentials_secret_id, host, port, status, size_mb, created_at
		FROM database_instances WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`
	return scanDatabase(s.pool.QueryRow(ctx, q, id, orgID))
}

func (s *Store) ListDatabaseInstances(ctx context.Context, orgID uuid.UUID) ([]DatabaseInstance, error) {
	const q = `
		SELECT id, organization_id, application_id, server_node_id, engine, version, name,
		       db_user, credentials_secret_id, host, port, status, size_mb, created_at
		FROM database_instances WHERE organization_id = $1 AND deleted_at IS NULL
		ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DatabaseInstance
	for rows.Next() {
		d, err := scanDatabase(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// MarkDatabaseRunning flips status to running (called when the agent reports success).
func (s *Store) MarkDatabaseRunning(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE database_instances SET status = 'running' WHERE id = $1`, id)
	return err
}

func scanDatabase(row rowScanner) (*DatabaseInstance, error) {
	var d DatabaseInstance
	if err := row.Scan(&d.ID, &d.OrganizationID, &d.ApplicationID, &d.ServerNodeID, &d.Engine,
		&d.Version, &d.Name, &d.DBUser, &d.CredentialsSecretID, &d.Host, &d.Port, &d.Status,
		&d.SizeMB, &d.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &d, nil
}

// --- Database users (named login roles with a privilege set) ---

type CreateDBUserParams struct {
	ID                  uuid.UUID
	OrgID               uuid.UUID
	DatabaseID          uuid.UUID
	Username            string
	HostScope           string
	Privileges          []string
	CredentialsSecretID uuid.NullUUID
}

func (s *Store) CreateDBUser(ctx context.Context, p CreateDBUserParams) (*DBUser, error) {
	const q = `
		INSERT INTO db_users (id, organization_id, database_id, username, host_scope, privileges, credentials_secret_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, organization_id, database_id, username, host_scope, privileges, credentials_secret_id, created_at`
	return scanDBUser(s.pool.QueryRow(ctx, q,
		p.ID, p.OrgID, p.DatabaseID, p.Username, p.HostScope, p.Privileges, p.CredentialsSecretID))
}

func (s *Store) ListDBUsers(ctx context.Context, orgID, databaseID uuid.UUID) ([]DBUser, error) {
	const q = `
		SELECT id, organization_id, database_id, username, host_scope, privileges, credentials_secret_id, created_at
		FROM db_users WHERE organization_id = $1 AND database_id = $2
		ORDER BY created_at`
	rows, err := s.pool.Query(ctx, q, orgID, databaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DBUser
	for rows.Next() {
		u, err := scanDBUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

func (s *Store) GetDBUser(ctx context.Context, orgID, id uuid.UUID) (*DBUser, error) {
	const q = `
		SELECT id, organization_id, database_id, username, host_scope, privileges, credentials_secret_id, created_at
		FROM db_users WHERE id = $1 AND organization_id = $2`
	return scanDBUser(s.pool.QueryRow(ctx, q, id, orgID))
}

func (s *Store) UpdateDBUserPrivileges(ctx context.Context, orgID, id uuid.UUID, privileges []string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE db_users SET privileges = $3, updated_at = now() WHERE id = $1 AND organization_id = $2`,
		id, orgID, privileges)
	return err
}

func (s *Store) DeleteDBUser(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM db_users WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanDBUser(row rowScanner) (*DBUser, error) {
	var u DBUser
	if err := row.Scan(&u.ID, &u.OrganizationID, &u.DatabaseID, &u.Username, &u.HostScope,
		&u.Privileges, &u.CredentialsSecretID, &u.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &u, nil
}
