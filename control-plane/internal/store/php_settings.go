package store

import (
	"context"

	"github.com/google/uuid"
)

// UpsertPhpSetting inserts or updates a directive for a website.
func (s *Store) UpsertPhpSetting(ctx context.Context, orgID, websiteID uuid.UUID, directive, value string) (*SitePhpSetting, error) {
	const q = `
		INSERT INTO site_php_settings (organization_id, website_id, directive, value)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (website_id, directive) DO UPDATE SET value = EXCLUDED.value
		RETURNING id, organization_id, website_id, directive, value, created_at`
	return scanPhpSetting(s.pool.QueryRow(ctx, q, orgID, websiteID, directive, value))
}

func (s *Store) ListPhpSettings(ctx context.Context, orgID, websiteID uuid.UUID) ([]SitePhpSetting, error) {
	const q = `
		SELECT id, organization_id, website_id, directive, value, created_at
		FROM site_php_settings WHERE organization_id = $1 AND website_id = $2 ORDER BY directive`
	rows, err := s.pool.Query(ctx, q, orgID, websiteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SitePhpSetting
	for rows.Next() {
		p, err := scanPhpSetting(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

func (s *Store) DeletePhpSetting(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM site_php_settings WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanPhpSetting(row rowScanner) (*SitePhpSetting, error) {
	var p SitePhpSetting
	if err := row.Scan(&p.ID, &p.OrganizationID, &p.WebsiteID, &p.Directive, &p.Value, &p.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &p, nil
}
