package store

import (
	"context"

	"github.com/google/uuid"
)

// Organization-level (application-independent) environment variables.

func (s *Store) ListEnvVars(ctx context.Context, orgID uuid.UUID) ([]EnvVar, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, organization_id, key, value, is_build_time, created_at
		FROM environment_variables WHERE organization_id = $1 AND application_id IS NULL ORDER BY key`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EnvVar
	for rows.Next() {
		var e EnvVar
		if err := rows.Scan(&e.ID, &e.OrganizationID, &e.Key, &e.Value, &e.IsBuildTime, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) UpsertEnvVar(ctx context.Context, orgID uuid.UUID, key, value string, buildTime bool) (*EnvVar, error) {
	const q = `
		INSERT INTO environment_variables (organization_id, key, value, is_build_time)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (organization_id, key) WHERE application_id IS NULL
		DO UPDATE SET value = EXCLUDED.value, is_build_time = EXCLUDED.is_build_time
		RETURNING id, organization_id, key, value, is_build_time, created_at`
	var e EnvVar
	if err := s.pool.QueryRow(ctx, q, orgID, key, value, buildTime).
		Scan(&e.ID, &e.OrganizationID, &e.Key, &e.Value, &e.IsBuildTime, &e.CreatedAt); err != nil {
		return nil, err
	}
	return &e, nil
}

func (s *Store) DeleteEnvVar(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM environment_variables WHERE id = $1 AND organization_id = $2 AND application_id IS NULL`, id, orgID)
	return err
}

// Organization-level secrets (metadata only; values are never returned).

func (s *Store) ListOrgSecrets(ctx context.Context, orgID uuid.UUID) ([]SecretMeta, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, organization_id, key, version, updated_at
		FROM secrets WHERE organization_id = $1 AND application_id IS NULL ORDER BY key`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SecretMeta
	for rows.Next() {
		var m SecretMeta
		if err := rows.Scan(&m.ID, &m.OrganizationID, &m.Key, &m.Version, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// UpsertOrgSecret stores/rotates an org-level secret (envelope-encrypted value).
func (s *Store) UpsertOrgSecret(ctx context.Context, orgID uuid.UUID, key string, ciphertext, nonce []byte, keyID string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO secrets (organization_id, key, ciphertext, nonce, key_id)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (organization_id, key) WHERE application_id IS NULL
		DO UPDATE SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce,
		              key_id = EXCLUDED.key_id, version = secrets.version + 1
		RETURNING id`, orgID, key, ciphertext, nonce, keyID).Scan(&id)
	return id, err
}

func (s *Store) DeleteSecret(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM secrets WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}
