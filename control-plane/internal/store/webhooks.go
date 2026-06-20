package store

import (
	"context"

	"github.com/google/uuid"
)

type CreateWebhookParams struct {
	OrgID  uuid.UUID
	URL    string
	Secret string
	Events []string
}

const webhookCols = `id, organization_id, url, secret, events, active, last_status, last_delivered_at, created_at`

func scanWebhook(row rowScanner) (*Webhook, error) {
	var h Webhook
	if err := row.Scan(&h.ID, &h.OrganizationID, &h.URL, &h.Secret, &h.Events, &h.Active,
		&h.LastStatus, &h.LastDeliveredAt, &h.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &h, nil
}

func (s *Store) CreateWebhook(ctx context.Context, p CreateWebhookParams) (*Webhook, error) {
	const q = `
		INSERT INTO webhooks (organization_id, url, secret, events)
		VALUES ($1, $2, $3, $4)
		RETURNING ` + webhookCols
	return scanWebhook(s.pool.QueryRow(ctx, q, p.OrgID, p.URL, p.Secret, p.Events))
}

// UpdateWebhook edits a webhook's target URL, subscribed events and active flag
// (the signing secret is unchanged).
func (s *Store) UpdateWebhook(ctx context.Context, orgID, id uuid.UUID, url string, events []string, active bool) (*Webhook, error) {
	const q = `
		UPDATE webhooks SET url = $3, events = $4, active = $5
		WHERE id = $1 AND organization_id = $2
		RETURNING ` + webhookCols
	return scanWebhook(s.pool.QueryRow(ctx, q, id, orgID, url, events, active))
}

func (s *Store) ListWebhooks(ctx context.Context, orgID uuid.UUID) ([]Webhook, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+webhookCols+` FROM webhooks WHERE organization_id = $1 ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Webhook
	for rows.Next() {
		h, err := scanWebhook(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *h)
	}
	return out, rows.Err()
}

// WebhooksForEvent returns active webhooks subscribed to the event (or to all
// events when their events list is empty).
func (s *Store) WebhooksForEvent(ctx context.Context, orgID uuid.UUID, event string) ([]Webhook, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+webhookCols+`
		FROM webhooks
		WHERE organization_id = $1 AND active AND (cardinality(events) = 0 OR $2 = ANY(events))`,
		orgID, event)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Webhook
	for rows.Next() {
		h, err := scanWebhook(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *h)
	}
	return out, rows.Err()
}

func (s *Store) GetWebhook(ctx context.Context, orgID, id uuid.UUID) (*Webhook, error) {
	return scanWebhook(s.pool.QueryRow(ctx,
		`SELECT `+webhookCols+` FROM webhooks WHERE id = $1 AND organization_id = $2`, id, orgID))
}

func (s *Store) DeleteWebhook(ctx context.Context, orgID, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM webhooks WHERE id = $1 AND organization_id = $2`, id, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) UpdateWebhookDelivery(ctx context.Context, id uuid.UUID, status int) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE webhooks SET last_status = $2, last_delivered_at = now() WHERE id = $1`, id, status)
	return err
}
