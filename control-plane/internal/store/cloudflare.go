package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type UpsertCloudflareParams struct {
	OrgID      uuid.UUID
	Label      string
	TokenCT    []byte
	TokenNonce []byte
	TokenKeyID string
	VerifiedAt *time.Time
}

const cloudflareColumns = `id, organization_id, label, token_ct, token_nonce, token_keyid, verified_at, created_at`

func scanCloudflare(row rowScanner) (*CloudflareAccount, error) {
	var a CloudflareAccount
	if err := row.Scan(&a.ID, &a.OrganizationID, &a.Label, &a.TokenCT, &a.TokenNonce,
		&a.TokenKeyID, &a.VerifiedAt, &a.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &a, nil
}

// UpsertCloudflareAccount connects (or re-connects) an org's Cloudflare token.
func (s *Store) UpsertCloudflareAccount(ctx context.Context, p UpsertCloudflareParams) (*CloudflareAccount, error) {
	return scanCloudflare(s.pool.QueryRow(ctx, `
		INSERT INTO cloudflare_accounts (organization_id, label, token_ct, token_nonce, token_keyid, verified_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (organization_id) DO UPDATE SET
			label = EXCLUDED.label, token_ct = EXCLUDED.token_ct, token_nonce = EXCLUDED.token_nonce,
			token_keyid = EXCLUDED.token_keyid, verified_at = EXCLUDED.verified_at
		RETURNING `+cloudflareColumns,
		p.OrgID, p.Label, p.TokenCT, p.TokenNonce, p.TokenKeyID, p.VerifiedAt))
}

func (s *Store) GetCloudflareAccount(ctx context.Context, orgID uuid.UUID) (*CloudflareAccount, error) {
	return scanCloudflare(s.pool.QueryRow(ctx,
		`SELECT `+cloudflareColumns+` FROM cloudflare_accounts WHERE organization_id = $1`, orgID))
}

func (s *Store) DeleteCloudflareAccount(ctx context.Context, orgID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM cloudflare_accounts WHERE organization_id = $1`, orgID)
	return err
}
