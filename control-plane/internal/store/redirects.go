package store

import (
	"context"

	"github.com/google/uuid"
)

type CreateRedirectParams struct {
	OrgID        uuid.UUID
	SourceDomain string
	SourcePath   string
	TargetURL    string
	StatusCode   int
}

func (s *Store) CreateRedirect(ctx context.Context, p CreateRedirectParams) (*Redirect, error) {
	const q = `
		INSERT INTO redirects (organization_id, source_domain, source_path, target_url, status_code)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, organization_id, source_domain, source_path, target_url, status_code, created_at`
	return scanRedirect(s.pool.QueryRow(ctx, q, p.OrgID, p.SourceDomain, p.SourcePath, p.TargetURL, p.StatusCode))
}

func (s *Store) ListRedirects(ctx context.Context, orgID uuid.UUID) ([]Redirect, error) {
	const q = `
		SELECT id, organization_id, source_domain, source_path, target_url, status_code, created_at
		FROM redirects WHERE organization_id = $1 ORDER BY source_domain, created_at`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Redirect
	for rows.Next() {
		r, err := scanRedirect(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (s *Store) DeleteRedirect(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM redirects WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanRedirect(row rowScanner) (*Redirect, error) {
	var r Redirect
	if err := row.Scan(&r.ID, &r.OrganizationID, &r.SourceDomain, &r.SourcePath,
		&r.TargetURL, &r.StatusCode, &r.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &r, nil
}
