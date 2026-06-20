package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type CreateAutoresponderParams struct {
	OrgID        uuid.UUID
	Address      string
	Subject      string
	Body         string
	IntervalDays int
	StartDate    *time.Time
	EndDate      *time.Time
}

func (s *Store) CreateAutoresponder(ctx context.Context, p CreateAutoresponderParams) (*MailAutoresponder, error) {
	const q = `
		INSERT INTO mail_autoresponders (organization_id, address, subject, body, interval_days, start_date, end_date)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, organization_id, address, subject, body, interval_days, start_date, end_date, enabled, created_at`
	return scanAutoresponder(s.pool.QueryRow(ctx, q,
		p.OrgID, p.Address, p.Subject, p.Body, p.IntervalDays, p.StartDate, p.EndDate))
}

func (s *Store) ListAutoresponders(ctx context.Context, orgID uuid.UUID) ([]MailAutoresponder, error) {
	const q = `
		SELECT id, organization_id, address, subject, body, interval_days, start_date, end_date, enabled, created_at
		FROM mail_autoresponders WHERE organization_id = $1 ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MailAutoresponder
	for rows.Next() {
		a, err := scanAutoresponder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// UpdateAutoresponder edits an autoresponder's message and active window (the
// address is the key and stays fixed). Org-scoped.
func (s *Store) UpdateAutoresponder(ctx context.Context, orgID, id uuid.UUID, subject, body string, intervalDays int, start, end *time.Time) (*MailAutoresponder, error) {
	const q = `
		UPDATE mail_autoresponders SET subject = $3, body = $4, interval_days = $5, start_date = $6, end_date = $7
		WHERE id = $1 AND organization_id = $2
		RETURNING id, organization_id, address, subject, body, interval_days, start_date, end_date, enabled, created_at`
	return scanAutoresponder(s.pool.QueryRow(ctx, q, id, orgID, subject, body, intervalDays, start, end))
}

func (s *Store) DeleteAutoresponder(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM mail_autoresponders WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanAutoresponder(row rowScanner) (*MailAutoresponder, error) {
	var a MailAutoresponder
	if err := row.Scan(&a.ID, &a.OrganizationID, &a.Address, &a.Subject, &a.Body, &a.IntervalDays,
		&a.StartDate, &a.EndDate, &a.Enabled, &a.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &a, nil
}
