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

// GetEffectiveBranding resolves the branding shown to an org: its own, else its
// parent reseller's, else nil (caller applies platform defaults).
func (s *Store) GetEffectiveBranding(ctx context.Context, orgID uuid.UUID) (*Branding, error) {
	own, err := s.GetBranding(ctx, orgID)
	if err == nil {
		return own, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	// Fall back to the parent's branding (a sub-account inherits its reseller's).
	parent, err := scanBranding(s.pool.QueryRow(ctx, `
		SELECT b.`+`panel_name, b.logo_url, b.primary_color, b.support_email, b.support_url
		FROM org_branding b
		JOIN organizations o ON o.parent_org_id = b.organization_id
		WHERE o.id = $1`, orgID))
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	return parent, err
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
