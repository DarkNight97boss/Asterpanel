package store

import (
	"context"

	"github.com/google/uuid"
)

// CreateForwarder inserts an email forwarder. source is either a full address
// (sales@example.com) or a catch-all (@example.com); destinations is one or more
// target addresses. Unique per (org, source).
func (s *Store) CreateForwarder(ctx context.Context, orgID uuid.UUID, source string, destinations []string, isCatchall bool) (*MailForwarder, error) {
	const q = `
		INSERT INTO mail_forwarders (organization_id, source, destinations, is_catchall)
		VALUES ($1, $2, $3, $4)
		RETURNING id, organization_id, source, destinations, is_catchall, created_at`
	return scanForwarder(s.pool.QueryRow(ctx, q, orgID, source, destinations, isCatchall))
}

func (s *Store) ListForwarders(ctx context.Context, orgID uuid.UUID) ([]MailForwarder, error) {
	const q = `
		SELECT id, organization_id, source, destinations, is_catchall, created_at
		FROM mail_forwarders WHERE organization_id = $1 ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MailForwarder
	for rows.Next() {
		f, err := scanForwarder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

func (s *Store) DeleteForwarder(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM mail_forwarders WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanForwarder(row rowScanner) (*MailForwarder, error) {
	var f MailForwarder
	if err := row.Scan(&f.ID, &f.OrganizationID, &f.Source, &f.Destinations, &f.IsCatchall, &f.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &f, nil
}
