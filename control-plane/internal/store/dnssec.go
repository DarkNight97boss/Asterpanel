package store

import (
	"context"

	"github.com/google/uuid"
)

func (s *Store) UpsertDnssec(ctx context.Context, orgID uuid.UUID, domain, dsRecord string, algorithm int) (*Dnssec, error) {
	const q = `
		INSERT INTO dnssec_keys (organization_id, domain, ds_record, algorithm, enabled)
		VALUES ($1, $2, $3, $4, true)
		ON CONFLICT (organization_id, domain) DO UPDATE
		   SET ds_record = EXCLUDED.ds_record, algorithm = EXCLUDED.algorithm, enabled = true
		RETURNING id, organization_id, domain, ds_record, algorithm, enabled, created_at`
	return scanDnssec(s.pool.QueryRow(ctx, q, orgID, domain, dsRecord, algorithm))
}

func (s *Store) ListDnssec(ctx context.Context, orgID uuid.UUID) ([]Dnssec, error) {
	const q = `
		SELECT id, organization_id, domain, ds_record, algorithm, enabled, created_at
		FROM dnssec_keys WHERE organization_id = $1 ORDER BY domain`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Dnssec
	for rows.Next() {
		d, err := scanDnssec(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

func (s *Store) GetDnssec(ctx context.Context, orgID, id uuid.UUID) (*Dnssec, error) {
	const q = `
		SELECT id, organization_id, domain, ds_record, algorithm, enabled, created_at
		FROM dnssec_keys WHERE id = $1 AND organization_id = $2`
	return scanDnssec(s.pool.QueryRow(ctx, q, id, orgID))
}

func (s *Store) DeleteDnssec(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM dnssec_keys WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanDnssec(row rowScanner) (*Dnssec, error) {
	var d Dnssec
	if err := row.Scan(&d.ID, &d.OrganizationID, &d.Domain, &d.DsRecord, &d.Algorithm, &d.Enabled, &d.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &d, nil
}
