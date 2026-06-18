package store

import (
	"context"

	"github.com/google/uuid"
)

type CreateSubdomainParams struct {
	OrgID        uuid.UUID
	Kind         string
	FQDN         string
	DocumentRoot string
	TargetURL    string
}

func (s *Store) CreateSubdomain(ctx context.Context, p CreateSubdomainParams) (*Subdomain, error) {
	const q = `
		INSERT INTO subdomains (organization_id, kind, fqdn, document_root, target_url)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, organization_id, kind, fqdn, document_root, target_url, status, created_at`
	return scanSubdomain(s.pool.QueryRow(ctx, q, p.OrgID, p.Kind, p.FQDN, p.DocumentRoot, p.TargetURL))
}

func (s *Store) ListSubdomains(ctx context.Context, orgID uuid.UUID) ([]Subdomain, error) {
	const q = `
		SELECT id, organization_id, kind, fqdn, document_root, target_url, status, created_at
		FROM subdomains WHERE organization_id = $1
		ORDER BY fqdn, created_at`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Subdomain
	for rows.Next() {
		sd, err := scanSubdomain(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sd)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSubdomain(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM subdomains WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanSubdomain(row rowScanner) (*Subdomain, error) {
	var sd Subdomain
	if err := row.Scan(&sd.ID, &sd.OrganizationID, &sd.Kind, &sd.FQDN, &sd.DocumentRoot,
		&sd.TargetURL, &sd.Status, &sd.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &sd, nil
}
