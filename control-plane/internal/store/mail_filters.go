package store

import (
	"context"

	"github.com/google/uuid"
)

type CreateFilterParams struct {
	OrgID     uuid.UUID
	Address   string
	Name      string
	Field     string
	Op        string
	Value     string
	Action    string
	ActionArg string
	Position  int
}

func (s *Store) CreateFilter(ctx context.Context, p CreateFilterParams) (*MailFilter, error) {
	const q = `
		INSERT INTO mail_filters (organization_id, address, name, field, op, value, action, action_arg, position)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, organization_id, address, name, field, op, value, action, action_arg, position, enabled, created_at`
	return scanFilter(s.pool.QueryRow(ctx, q,
		p.OrgID, p.Address, p.Name, p.Field, p.Op, p.Value, p.Action, p.ActionArg, p.Position))
}

func (s *Store) ListFilters(ctx context.Context, orgID uuid.UUID) ([]MailFilter, error) {
	const q = `
		SELECT id, organization_id, address, name, field, op, value, action, action_arg, position, enabled, created_at
		FROM mail_filters WHERE organization_id = $1 ORDER BY address, position, created_at`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MailFilter
	for rows.Next() {
		f, err := scanFilter(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

func (s *Store) DeleteFilter(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM mail_filters WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanFilter(row rowScanner) (*MailFilter, error) {
	var f MailFilter
	if err := row.Scan(&f.ID, &f.OrganizationID, &f.Address, &f.Name, &f.Field, &f.Op, &f.Value,
		&f.Action, &f.ActionArg, &f.Position, &f.Enabled, &f.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &f, nil
}
