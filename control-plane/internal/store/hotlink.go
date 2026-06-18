package store

import (
	"context"

	"github.com/google/uuid"
)

type CreateHotlinkParams struct {
	OrgID           uuid.UUID
	Domain          string
	AllowedReferers []string
	Extensions      []string
}

func (s *Store) UpsertHotlink(ctx context.Context, p CreateHotlinkParams) (*HotlinkProtection, error) {
	const q = `
		INSERT INTO hotlink_protection (organization_id, domain, allowed_referers, extensions)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (organization_id, domain) DO UPDATE
		   SET allowed_referers = EXCLUDED.allowed_referers, extensions = EXCLUDED.extensions
		RETURNING id, organization_id, domain, allowed_referers, extensions, created_at`
	return scanHotlink(s.pool.QueryRow(ctx, q, p.OrgID, p.Domain, p.AllowedReferers, p.Extensions))
}

func (s *Store) ListHotlink(ctx context.Context, orgID uuid.UUID) ([]HotlinkProtection, error) {
	const q = `
		SELECT id, organization_id, domain, allowed_referers, extensions, created_at
		FROM hotlink_protection WHERE organization_id = $1 ORDER BY domain`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HotlinkProtection
	for rows.Next() {
		h, err := scanHotlink(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *h)
	}
	return out, rows.Err()
}

func (s *Store) DeleteHotlink(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM hotlink_protection WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanHotlink(row rowScanner) (*HotlinkProtection, error) {
	var h HotlinkProtection
	if err := row.Scan(&h.ID, &h.OrganizationID, &h.Domain, &h.AllowedReferers, &h.Extensions, &h.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &h, nil
}
