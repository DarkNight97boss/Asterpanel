package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/DarkNight97boss/asterpanel/control-plane/internal/audit"
)

// Append implements audit.Sink. It serializes appends per organization using a
// transaction-scoped advisory lock so the hash chain is well-ordered, computes
// hash = SHA-256(prev_hash || canonical(entry)), and inserts the row. The DB
// triggers guarantee the row can never be updated or deleted afterwards.
func (s *Store) Append(ctx context.Context, e audit.Entry) error {
	if e.CreatedAt.IsZero() {
		e.CreatedAt = time.Now().UTC()
	}
	if e.ActorType == "" {
		e.ActorType = audit.ActorSystem
	}
	if e.Outcome == "" {
		e.Outcome = audit.OutcomeSuccess
	}

	lockKey := "system"
	if e.OrganizationID != nil {
		lockKey = e.OrganizationID.String()
	}

	return s.withTx(ctx, func(tx pgx.Tx) error {
		// Serialize this org's chain for the duration of the transaction.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
			return err
		}

		var prev []byte
		err := tx.QueryRow(ctx, `
			SELECT hash FROM audit_logs
			WHERE organization_id IS NOT DISTINCT FROM $1
			ORDER BY id DESC LIMIT 1`, e.OrganizationID).Scan(&prev)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}

		hash, err := audit.ChainHash(prev, e)
		if err != nil {
			return err
		}

		meta, err := json.Marshal(e.Metadata)
		if err != nil {
			return err
		}
		if e.Metadata == nil {
			meta = []byte("{}")
		}

		var ip *string
		if e.IP != "" {
			ip = &e.IP
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO audit_logs (organization_id, actor_user_id, actor_type, actor_token_id, session_id,
			                        action, resource_type, resource_id, outcome, ip, user_agent, request_id,
			                        metadata, prev_hash, hash, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::inet, $11, $12, $13::jsonb, $14, $15, $16)`,
			e.OrganizationID, e.ActorUserID, e.ActorType, e.ActorTokenID, e.SessionID,
			e.Action, nullString(e.ResourceType), nullString(e.ResourceID), e.Outcome, ip,
			nullString(e.UserAgent), nullString(e.RequestID), string(meta), prev, hash, e.CreatedAt)
		return err
	})
}

func nullString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
