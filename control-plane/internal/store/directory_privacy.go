package store

import (
	"context"

	"github.com/google/uuid"
)

type CreateDirPrivacyParams struct {
	OrgID        uuid.UUID
	Domain       string
	Path         string
	Username     string
	PasswordHash string
}

func (s *Store) CreateDirectoryPrivacy(ctx context.Context, p CreateDirPrivacyParams) (*DirectoryPrivacy, error) {
	const q = `
		INSERT INTO directory_privacy (organization_id, domain, path, username, password_hash)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, organization_id, domain, path, username, password_hash, created_at`
	return scanDirPrivacy(s.pool.QueryRow(ctx, q, p.OrgID, p.Domain, p.Path, p.Username, p.PasswordHash))
}

func (s *Store) ListDirectoryPrivacy(ctx context.Context, orgID uuid.UUID) ([]DirectoryPrivacy, error) {
	const q = `
		SELECT id, organization_id, domain, path, username, password_hash, created_at
		FROM directory_privacy WHERE organization_id = $1 ORDER BY domain, path, created_at`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DirectoryPrivacy
	for rows.Next() {
		d, err := scanDirPrivacy(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

func (s *Store) DeleteDirectoryPrivacy(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM directory_privacy WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanDirPrivacy(row rowScanner) (*DirectoryPrivacy, error) {
	var d DirectoryPrivacy
	if err := row.Scan(&d.ID, &d.OrganizationID, &d.Domain, &d.Path, &d.Username, &d.PasswordHash, &d.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &d, nil
}
