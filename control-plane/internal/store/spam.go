package store

import (
	"context"

	"github.com/google/uuid"
)

// GetSpamSettings returns the org's spam settings, creating the default row on
// first access (so the UI always has values to show).
func (s *Store) GetSpamSettings(ctx context.Context, orgID uuid.UUID) (*SpamSettings, error) {
	const q = `
		INSERT INTO mail_spam_settings (organization_id) VALUES ($1)
		ON CONFLICT (organization_id) DO UPDATE SET organization_id = EXCLUDED.organization_id
		RETURNING organization_id, reject_score, add_header_score, greylisting`
	var st SpamSettings
	if err := s.pool.QueryRow(ctx, q, orgID).Scan(&st.OrganizationID, &st.RejectScore, &st.AddHeaderScore, &st.Greylisting); err != nil {
		return nil, err
	}
	return &st, nil
}

func (s *Store) UpdateSpamSettings(ctx context.Context, orgID uuid.UUID, reject, addHeader int, greylisting bool) (*SpamSettings, error) {
	const q = `
		INSERT INTO mail_spam_settings (organization_id, reject_score, add_header_score, greylisting, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (organization_id) DO UPDATE
		   SET reject_score = EXCLUDED.reject_score,
		       add_header_score = EXCLUDED.add_header_score,
		       greylisting = EXCLUDED.greylisting,
		       updated_at = now()
		RETURNING organization_id, reject_score, add_header_score, greylisting`
	var st SpamSettings
	if err := s.pool.QueryRow(ctx, q, orgID, reject, addHeader, greylisting).Scan(
		&st.OrganizationID, &st.RejectScore, &st.AddHeaderScore, &st.Greylisting); err != nil {
		return nil, err
	}
	return &st, nil
}

func (s *Store) CreateSpamRule(ctx context.Context, orgID uuid.UUID, kind, value string) (*SpamRule, error) {
	const q = `
		INSERT INTO mail_spam_rules (organization_id, kind, value)
		VALUES ($1, $2, $3)
		RETURNING id, organization_id, kind, value, created_at`
	return scanSpamRule(s.pool.QueryRow(ctx, q, orgID, kind, value))
}

func (s *Store) ListSpamRules(ctx context.Context, orgID uuid.UUID) ([]SpamRule, error) {
	const q = `
		SELECT id, organization_id, kind, value, created_at
		FROM mail_spam_rules WHERE organization_id = $1 ORDER BY kind, value`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpamRule
	for rows.Next() {
		r, err := scanSpamRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSpamRule(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM mail_spam_rules WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanSpamRule(row rowScanner) (*SpamRule, error) {
	var r SpamRule
	if err := row.Scan(&r.ID, &r.OrganizationID, &r.Kind, &r.Value, &r.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &r, nil
}
