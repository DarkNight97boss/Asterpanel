package store

import (
	"context"

	"github.com/google/uuid"
)

type CreateWebdavParams struct {
	OrgID        uuid.UUID
	Domain       string
	Path         string
	Username     string
	PasswordHash string
	Root         string
}

func (s *Store) CreateWebdav(ctx context.Context, p CreateWebdavParams) (*WebdavAccount, error) {
	const q = `
		INSERT INTO webdav_accounts (organization_id, domain, path, username, password_hash, root)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, organization_id, domain, path, username, password_hash, root, created_at`
	return scanWebdav(s.pool.QueryRow(ctx, q, p.OrgID, p.Domain, p.Path, p.Username, p.PasswordHash, p.Root))
}

func (s *Store) ListWebdav(ctx context.Context, orgID uuid.UUID) ([]WebdavAccount, error) {
	const q = `
		SELECT id, organization_id, domain, path, username, password_hash, root, created_at
		FROM webdav_accounts WHERE organization_id = $1 ORDER BY domain, username`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WebdavAccount
	for rows.Next() {
		a, err := scanWebdav(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func (s *Store) DeleteWebdav(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM webdav_accounts WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanWebdav(row rowScanner) (*WebdavAccount, error) {
	var a WebdavAccount
	if err := row.Scan(&a.ID, &a.OrganizationID, &a.Domain, &a.Path, &a.Username, &a.PasswordHash, &a.Root, &a.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &a, nil
}
