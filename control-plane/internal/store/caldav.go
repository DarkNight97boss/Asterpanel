package store

import (
	"context"

	"github.com/google/uuid"
)

func (s *Store) CreateCaldavAccount(ctx context.Context, orgID uuid.UUID, username, passwordHash string) (*CaldavAccount, error) {
	const q = `
		INSERT INTO caldav_accounts (organization_id, username, password_hash)
		VALUES ($1, $2, $3)
		RETURNING id, organization_id, username, password_hash, created_at`
	return scanCaldav(s.pool.QueryRow(ctx, q, orgID, username, passwordHash))
}

func (s *Store) ListCaldavAccounts(ctx context.Context, orgID uuid.UUID) ([]CaldavAccount, error) {
	const q = `
		SELECT id, organization_id, username, password_hash, created_at
		FROM caldav_accounts WHERE organization_id = $1 ORDER BY username`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CaldavAccount
	for rows.Next() {
		a, err := scanCaldav(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func (s *Store) DeleteCaldavAccount(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM caldav_accounts WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanCaldav(row rowScanner) (*CaldavAccount, error) {
	var a CaldavAccount
	if err := row.Scan(&a.ID, &a.OrganizationID, &a.Username, &a.PasswordHash, &a.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &a, nil
}
