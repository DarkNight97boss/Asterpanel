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
