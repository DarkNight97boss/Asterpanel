package store

import (
	"context"

	"github.com/google/uuid"
)

func (s *Store) CreateWafRule(ctx context.Context, orgID uuid.UUID, matchType, pattern string, note *string) (*WafRule, error) {
	const q = `
		INSERT INTO waf_rules (organization_id, match_type, pattern, note)
		VALUES ($1, $2, $3, $4)
		RETURNING id, organization_id, match_type, pattern, note, created_at`
	return scanWaf(s.pool.QueryRow(ctx, q, orgID, matchType, pattern, note))
}

func (s *Store) ListWafRules(ctx context.Context, orgID uuid.UUID) ([]WafRule, error) {
	const q = `
		SELECT id, organization_id, match_type, pattern, note, created_at
		FROM waf_rules WHERE organization_id = $1 ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WafRule
	for rows.Next() {
		r, err := scanWaf(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (s *Store) DeleteWafRule(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM waf_rules WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanWaf(row rowScanner) (*WafRule, error) {
	var r WafRule
	if err := row.Scan(&r.ID, &r.OrganizationID, &r.MatchType, &r.Pattern, &r.Note, &r.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &r, nil
}
