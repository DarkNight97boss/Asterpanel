package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// --- Sessions -----------------------------------------------------------------

type CreateSessionParams struct {
	UserID    uuid.UUID
	OrgID     uuid.NullUUID
	UserAgent *string
	IP        *string
	MFA       bool
	ExpiresAt time.Time
}

func (s *Store) CreateSession(ctx context.Context, p CreateSessionParams) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO sessions (user_id, organization_id, user_agent, ip, mfa_satisfied, expires_at)
		VALUES ($1, $2, $3, $4::inet, $5, $6)
		RETURNING id`,
		p.UserID, p.OrgID, p.UserAgent, p.IP, p.MFA, p.ExpiresAt).Scan(&id)
	return id, err
}

func (s *Store) RevokeSession(ctx context.Context, sessionID uuid.UUID, reason string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
		sessionID, reason)
	return err
}

func (s *Store) RevokeAllUserSessions(ctx context.Context, userID uuid.UUID, reason string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
		userID, reason)
	return err
}

// IsSessionActive reports whether a session exists, is unrevoked and unexpired.
func (s *Store) IsSessionActive(ctx context.Context, sessionID uuid.UUID) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx,
		`SELECT (revoked_at IS NULL AND expires_at > now()) FROM sessions WHERE id = $1`,
		sessionID).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return ok, err
}

// --- Refresh tokens (rotation + reuse detection) ------------------------------

var (
	ErrRefreshNotFound = errors.New("store: refresh token not found")
	ErrRefreshReuse    = errors.New("store: refresh token reuse detected")
	ErrRefreshExpired  = errors.New("store: refresh token expired")
)

// IssueRefreshToken stores the first refresh token of a new family (called at login).
func (s *Store) IssueRefreshToken(ctx context.Context, sessionID, userID uuid.UUID, tokenHash []byte, expiresAt time.Time) (familyID uuid.UUID, err error) {
	familyID = uuid.New()
	_, err = s.pool.Exec(ctx, `
		INSERT INTO refresh_tokens (session_id, user_id, family_id, token_hash, expires_at)
		VALUES ($1, $2, $3, $4, $5)`,
		sessionID, userID, familyID, tokenHash, expiresAt)
	return familyID, err
}

type RotateResult struct {
	SessionID uuid.UUID
	UserID    uuid.UUID
	OrgID     uuid.NullUUID
	FamilyID  uuid.UUID
}

// RotateRefreshToken atomically consumes presentedHash and issues newHash within
// the same rotation family. If the presented token was already rotated or
// revoked, this is a replay of a stolen token: the entire family and its
// sessions are revoked and ErrRefreshReuse is returned (the revocation commits).
func (s *Store) RotateRefreshToken(ctx context.Context, presentedHash, newHash []byte, newExpiresAt, now time.Time) (*RotateResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	var (
		id          uuid.UUID
		sessionID   uuid.UUID
		userID      uuid.UUID
		familyID    uuid.UUID
		expiresAt   time.Time
		rotatedAt   *time.Time
		revokedAt   *time.Time
		sessionDead bool
	)
	err = tx.QueryRow(ctx, `
		SELECT rt.id, rt.session_id, rt.user_id, rt.family_id, rt.expires_at, rt.rotated_at, rt.revoked_at,
		       (s.revoked_at IS NOT NULL OR s.expires_at < now()) AS session_dead
		FROM refresh_tokens rt
		JOIN sessions s ON s.id = rt.session_id
		WHERE rt.token_hash = $1
		FOR UPDATE OF rt`, presentedHash).
		Scan(&id, &sessionID, &userID, &familyID, &expiresAt, &rotatedAt, &revokedAt, &sessionDead)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrRefreshNotFound
	}
	if err != nil {
		return nil, err
	}

	// If the session was revoked (e.g. logout) or expired, the refresh token is
	// no longer usable even if it was never itself rotated.
	if sessionDead {
		_, _ = tx.Exec(ctx,
			`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'session_revoked'
			 WHERE family_id = $1 AND revoked_at IS NULL`, familyID)
		_ = tx.Commit(ctx)
		committed = true
		return nil, ErrRefreshNotFound
	}

	// Reuse detection: a token presented after it was rotated or revoked.
	if rotatedAt != nil || revokedAt != nil {
		if _, err := tx.Exec(ctx,
			`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'reuse_detected'
			 WHERE family_id = $1 AND revoked_at IS NULL`, familyID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_reuse'
			 WHERE id IN (SELECT DISTINCT session_id FROM refresh_tokens WHERE family_id = $1)
			   AND revoked_at IS NULL`, familyID); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		committed = true
		return nil, ErrRefreshReuse
	}

	if now.After(expiresAt) {
		_, _ = tx.Exec(ctx, `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason='expired' WHERE id = $1`, id)
		_ = tx.Commit(ctx)
		committed = true
		return nil, ErrRefreshExpired
	}

	// Consume current, issue successor in the same family.
	if _, err := tx.Exec(ctx, `UPDATE refresh_tokens SET rotated_at = $2 WHERE id = $1`, id, now); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO refresh_tokens (session_id, user_id, family_id, token_hash, prev_token_id, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		sessionID, userID, familyID, newHash, id, newExpiresAt); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, sessionID); err != nil {
		return nil, err
	}

	var orgID uuid.NullUUID
	if err := tx.QueryRow(ctx, `SELECT organization_id FROM sessions WHERE id = $1`, sessionID).Scan(&orgID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	committed = true
	return &RotateResult{SessionID: sessionID, UserID: userID, OrgID: orgID, FamilyID: familyID}, nil
}

// --- TOTP ---------------------------------------------------------------------

func (s *Store) UpsertTOTP(ctx context.Context, userID uuid.UUID, ciphertext, nonce []byte, keyID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO totp_secrets (user_id, secret_encrypted, nonce, key_id)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE
		SET secret_encrypted = EXCLUDED.secret_encrypted, nonce = EXCLUDED.nonce,
		    key_id = EXCLUDED.key_id, confirmed_at = NULL`,
		userID, ciphertext, nonce, keyID)
	return err
}

type TOTPRow struct {
	Ciphertext []byte
	Nonce      []byte
	KeyID      string
	Confirmed  bool
}

func (s *Store) GetTOTP(ctx context.Context, userID uuid.UUID) (*TOTPRow, error) {
	var r TOTPRow
	var confirmedAt *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT secret_encrypted, nonce, key_id, confirmed_at FROM totp_secrets WHERE user_id = $1`, userID).
		Scan(&r.Ciphertext, &r.Nonce, &r.KeyID, &confirmedAt)
	if err != nil {
		return nil, norows(err)
	}
	r.Confirmed = confirmedAt != nil
	return &r, nil
}

func (s *Store) ConfirmTOTP(ctx context.Context, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE totp_secrets SET confirmed_at = now() WHERE user_id = $1`, userID)
	return err
}

// --- API tokens ---------------------------------------------------------------

func (s *Store) CreateAPIToken(ctx context.Context, orgID uuid.UUID, userID uuid.NullUUID, name, prefix string, tokenHash []byte, scopes []string, expiresAt *time.Time) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO api_tokens (organization_id, user_id, name, prefix, token_hash, scopes, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id`,
		orgID, userID, name, prefix, tokenHash, scopes, expiresAt).Scan(&id)
	return id, err
}

type APITokenAuth struct {
	ID        uuid.UUID
	OrgID     uuid.UUID
	UserID    uuid.NullUUID
	TokenHash []byte
	Scopes    []string
	Revoked   bool
	Expired   bool
}

// GetAPITokenByPrefix fetches the token row for constant-time hash comparison.
func (s *Store) GetAPITokenByPrefix(ctx context.Context, prefix string) (*APITokenAuth, error) {
	var t APITokenAuth
	var revokedAt, expiresAt *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT id, organization_id, user_id, token_hash, scopes, revoked_at, expires_at
		FROM api_tokens WHERE prefix = $1`, prefix).
		Scan(&t.ID, &t.OrgID, &t.UserID, &t.TokenHash, &t.Scopes, &revokedAt, &expiresAt)
	if err != nil {
		return nil, norows(err)
	}
	t.Revoked = revokedAt != nil
	t.Expired = expiresAt != nil && time.Now().After(*expiresAt)
	return &t, nil
}

func (s *Store) TouchAPIToken(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, id)
	return err
}

func (s *Store) RevokeAPIToken(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL`,
		id, orgID)
	return err
}

// ListAPITokens returns the org's tokens (never the secret or its hash).
func (s *Store) ListAPITokens(ctx context.Context, orgID uuid.UUID) ([]APIToken, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, organization_id, user_id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at
		FROM api_tokens WHERE organization_id = $1 ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []APIToken
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.OrganizationID, &t.UserID, &t.Name, &t.Prefix, &t.Scopes,
			&t.LastUsedAt, &t.ExpiresAt, &t.RevokedAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
