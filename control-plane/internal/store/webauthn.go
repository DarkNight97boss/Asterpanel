package store

import (
	"context"

	"github.com/google/uuid"
)

type WebAuthnCredential struct {
	CredentialID []byte
	PublicKey    []byte
	AAGUID       []byte
	SignCount    int64
	Transports   []string
	Name         *string
}

func (s *Store) ListWebAuthnCredentials(ctx context.Context, userID uuid.UUID) ([]WebAuthnCredential, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT credential_id, public_key, aaguid, sign_count, transports, name
		 FROM webauthn_credentials WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WebAuthnCredential
	for rows.Next() {
		var c WebAuthnCredential
		var aaguid uuid.NullUUID
		if err := rows.Scan(&c.CredentialID, &c.PublicKey, &aaguid, &c.SignCount, &c.Transports, &c.Name); err != nil {
			return nil, err
		}
		if aaguid.Valid {
			b := aaguid.UUID
			c.AAGUID = b[:]
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CountWebAuthnCredentials reports how many passkeys a user has registered.
func (s *Store) CountWebAuthnCredentials(ctx context.Context, userID uuid.UUID) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM webauthn_credentials WHERE user_id = $1`, userID).Scan(&n)
	return n, err
}

func (s *Store) CreateWebAuthnCredential(ctx context.Context, userID uuid.UUID, c WebAuthnCredential) error {
	var aaguid uuid.NullUUID
	if len(c.AAGUID) == 16 {
		if u, err := uuid.FromBytes(c.AAGUID); err == nil {
			aaguid = uuid.NullUUID{UUID: u, Valid: true}
		}
	}
	transports := c.Transports
	if transports == nil {
		transports = []string{}
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO webauthn_credentials (user_id, credential_id, public_key, aaguid, sign_count, transports, name)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		userID, c.CredentialID, c.PublicKey, aaguid, c.SignCount, transports, c.Name)
	return err
}

func (s *Store) UpdateWebAuthnSignCount(ctx context.Context, credentialID []byte, signCount int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE webauthn_credentials SET sign_count = $2, last_used_at = now() WHERE credential_id = $1`,
		credentialID, signCount)
	return err
}

func (s *Store) DeleteWebAuthnCredential(ctx context.Context, userID uuid.UUID, credentialID []byte) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2`, userID, credentialID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
