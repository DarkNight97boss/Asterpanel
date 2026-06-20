package store

import (
	"context"

	"github.com/google/uuid"
)

const ssoColumns = `id, organization_id, name, issuer, client_id,
	client_secret_ct, client_secret_nonce, client_secret_keyid, allowed_domains, enabled, created_at`

func scanSSOProvider(row rowScanner) (*SSOProvider, error) {
	var p SSOProvider
	if err := row.Scan(&p.ID, &p.OrganizationID, &p.Name, &p.Issuer, &p.ClientID,
		&p.ClientSecretCT, &p.ClientSecretNonce, &p.ClientSecretKeyID, &p.AllowedDomains,
		&p.Enabled, &p.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &p, nil
}

type CreateSSOProviderParams struct {
	OrgID             uuid.UUID
	Name              string
	Issuer            string
	ClientID          string
	ClientSecretCT    []byte
	ClientSecretNonce []byte
	ClientSecretKeyID string
	AllowedDomains    string
	Enabled           bool
}

func (s *Store) CreateSSOProvider(ctx context.Context, p CreateSSOProviderParams) (*SSOProvider, error) {
	return scanSSOProvider(s.pool.QueryRow(ctx, `
		INSERT INTO sso_providers
			(organization_id, name, issuer, client_id, client_secret_ct, client_secret_nonce, client_secret_keyid, allowed_domains, enabled)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING `+ssoColumns,
		p.OrgID, p.Name, p.Issuer, p.ClientID, p.ClientSecretCT, p.ClientSecretNonce, p.ClientSecretKeyID, p.AllowedDomains, p.Enabled))
}

// ListSSOProvidersForOrg returns an org's configured providers (admin view).
func (s *Store) ListSSOProvidersForOrg(ctx context.Context, orgID uuid.UUID) ([]SSOProvider, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+ssoColumns+` FROM sso_providers WHERE organization_id = $1 ORDER BY created_at`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SSOProvider
	for rows.Next() {
		p, err := scanSSOProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// ListEnabledSSOProviders returns every enabled provider; used by the pre-auth
// login page to render its "Sign in with …" buttons.
func (s *Store) ListEnabledSSOProviders(ctx context.Context) ([]SSOProvider, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+ssoColumns+` FROM sso_providers WHERE enabled ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SSOProvider
	for rows.Next() {
		p, err := scanSSOProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

func (s *Store) GetSSOProvider(ctx context.Context, id uuid.UUID) (*SSOProvider, error) {
	return scanSSOProvider(s.pool.QueryRow(ctx, `SELECT `+ssoColumns+` FROM sso_providers WHERE id = $1`, id))
}

// UpdateSSOProvider edits a provider's non-secret fields (issuer is the key and
// stays fixed).
func (s *Store) UpdateSSOProvider(ctx context.Context, orgID, id uuid.UUID, name, clientID, allowedDomains string, enabled bool) (*SSOProvider, error) {
	const q = `
		UPDATE sso_providers SET name = $3, client_id = $4, allowed_domains = $5, enabled = $6
		WHERE id = $1 AND organization_id = $2
		RETURNING ` + ssoColumns
	return scanSSOProvider(s.pool.QueryRow(ctx, q, id, orgID, name, clientID, allowedDomains, enabled))
}

// UpdateSSOProviderSecret rotates the encrypted client secret in place.
func (s *Store) UpdateSSOProviderSecret(ctx context.Context, orgID, id uuid.UUID, ct, nonce []byte, keyID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sso_providers SET client_secret_ct = $3, client_secret_nonce = $4, client_secret_keyid = $5
		 WHERE id = $1 AND organization_id = $2`, id, orgID, ct, nonce, keyID)
	return err
}

func (s *Store) DeleteSSOProvider(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sso_providers WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}
