package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type CreateJobParams struct {
	ID           uuid.UUID
	OrgID        uuid.NullUUID
	NodeID       uuid.NullUUID
	Type         string
	Payload      []byte // JSON
	Nonce        string
	Signature    string
	SigningKeyID string
	IssuedAt     time.Time
	ExpiresAt    time.Time
	CreatedBy    uuid.NullUUID
}

// CreateJob persists a signed job in the 'pending' state.
func (s *Store) CreateJob(ctx context.Context, p CreateJobParams) error {
	payload := string(p.Payload)
	if payload == "" {
		payload = "{}"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO jobs (id, organization_id, server_node_id, type, payload, nonce, signature,
		                  signing_key_id, issued_at, expires_at, created_by, status)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, 'pending')`,
		p.ID, p.OrgID, p.NodeID, p.Type, payload, p.Nonce, p.Signature,
		p.SigningKeyID, p.IssuedAt, p.ExpiresAt, p.CreatedBy)
	return err
}

func (s *Store) MarkJobDispatched(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE jobs SET status = 'dispatched', dispatched_at = now(), attempts = attempts + 1 WHERE id = $1`, id)
	return err
}

// UpdateJobStatus records a terminal/intermediate status reported by the agent.
func (s *Store) UpdateJobStatus(ctx context.Context, id uuid.UUID, status string, result []byte, errMsg *string) error {
	res := string(result)
	if res == "" {
		res = "null"
	}
	terminal := status == "succeeded" || status == "failed" || status == "expired" || status == "canceled"
	_, err := s.pool.Exec(ctx, `
		UPDATE jobs
		SET status = $2, result = $3::jsonb, error = $4,
		    completed_at = CASE WHEN $5 THEN now() ELSE completed_at END
		WHERE id = $1`, id, status, res, errMsg, terminal)
	return err
}
