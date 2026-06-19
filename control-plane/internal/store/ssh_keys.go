package store

import (
	"context"

	"github.com/google/uuid"
)

type CreateSSHKeyParams struct {
	OrgID       uuid.UUID
	Name        string
	KeyType     string
	PublicKey   string
	Fingerprint string
}

func (s *Store) CreateSSHKey(ctx context.Context, p CreateSSHKeyParams) (*SSHKey, error) {
	const q = `
		INSERT INTO ssh_keys (organization_id, name, key_type, public_key, fingerprint)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, organization_id, name, key_type, public_key, fingerprint, created_at`
	return scanSSHKey(s.pool.QueryRow(ctx, q, p.OrgID, p.Name, p.KeyType, p.PublicKey, p.Fingerprint))
}

func (s *Store) ListSSHKeys(ctx context.Context, orgID uuid.UUID) ([]SSHKey, error) {
	const q = `
		SELECT id, organization_id, name, key_type, public_key, fingerprint, created_at
		FROM ssh_keys WHERE organization_id = $1
		ORDER BY created_at`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SSHKey
	for rows.Next() {
		k, err := scanSSHKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *k)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSSHKey(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM ssh_keys WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanSSHKey(row rowScanner) (*SSHKey, error) {
	var k SSHKey
	if err := row.Scan(&k.ID, &k.OrganizationID, &k.Name, &k.KeyType, &k.PublicKey,
		&k.Fingerprint, &k.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &k, nil
}
