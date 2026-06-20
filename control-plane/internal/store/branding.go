package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

type Branding struct {
	PanelName    *string
	LogoURL      *string
	PrimaryColor *string
	SupportEmail *string
	SupportURL   *string
}

const brandingCols = `panel_name, logo_url, primary_color, support_email, support_url`

func scanBranding(row rowScanner) (*Branding, error) {
	var b Branding
	if err := row.Scan(&b.PanelName, &b.LogoURL, &b.PrimaryColor, &b.SupportEmail, &b.SupportURL); err != nil {
		return nil, norows(err)
	}
	return &b, nil
}

// GetBranding returns the org's own branding row, or ErrNotFound.
func (s *Store) GetBranding(ctx context.Context, orgID uuid.UUID) (*Branding, error) {
	return scanBranding(s.pool.QueryRow(ctx,
		`SELECT `+brandingCols+` FROM org_branding WHERE organization_id = $1`, orgID))
}

// GetEffectiveBranding resolves the branding shown to an org: its own if set,
// otherwise the NEAREST ancestor reseller's — walking parent_org_id up the whole
// chain, not just one level, so a sub-reseller's customer still inherits the
// master's white-label. Returns nil when no org in the chain has branding (the
// caller applies platform defaults). The depth cap bounds the walk against a
// malformed cycle.
func (s *Store) GetEffectiveBranding(ctx context.Context, orgID uuid.UUID) (*Branding, error) {
	const q = `
		WITH RECURSIVE chain AS (
			SELECT id, parent_org_id, 0 AS depth FROM organizations
			WHERE id = $1 AND deleted_at IS NULL
			UNION ALL
			SELECT o.id, o.parent_org_id, c.depth + 1 FROM organizations o
			JOIN chain c ON o.id = c.parent_org_id
			WHERE o.deleted_at IS NULL AND c.depth < 64
		)
		SELECT b.panel_name, b.logo_url, b.primary_color, b.support_email, b.support_url
		FROM chain c
		JOIN org_branding b ON b.organization_id = c.id
		ORDER BY c.depth
		LIMIT 1`
	b, err := scanBranding(s.pool.QueryRow(ctx, q, orgID))
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	return b, err
}

// UpsertBranding sets the org's own branding (nil fields clear to NULL).
func (s *Store) UpsertBranding(ctx context.Context, orgID uuid.UUID, b Branding) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO org_branding (organization_id, panel_name, logo_url, primary_color, support_email, support_url, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (organization_id) DO UPDATE SET
			panel_name = $2, logo_url = $3, primary_color = $4,
			support_email = $5, support_url = $6, updated_at = now()`,
		orgID, b.PanelName, b.LogoURL, b.PrimaryColor, b.SupportEmail, b.SupportURL)
	return err
}
