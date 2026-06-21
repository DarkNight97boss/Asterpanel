package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type Ticket struct {
	ID           uuid.UUID
	Subject      string
	Status       string
	Priority     string
	CreatedBy    uuid.NullUUID
	CreatedAt    time.Time
	UpdatedAt    time.Time
	MessageCount int           // populated by ListTickets
	Messages     []TicketMessage // populated by GetTicket
}

type TicketMessage struct {
	ID        uuid.UUID
	Author    uuid.NullUUID
	Body      string
	Staff     bool
	CreatedAt time.Time
}

const ticketCols = `id, subject, status, priority, created_by, created_at, updated_at`

func scanTicket(row rowScanner) (*Ticket, error) {
	var t Ticket
	if err := row.Scan(&t.ID, &t.Subject, &t.Status, &t.Priority, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, norows(err)
	}
	return &t, nil
}

// CreateTicket opens a ticket with its first message in one transaction.
func (s *Store) CreateTicket(ctx context.Context, orgID uuid.UUID, subject, priority string, createdBy uuid.UUID, body string) (*Ticket, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	t, err := scanTicket(tx.QueryRow(ctx, `
		INSERT INTO support_tickets (organization_id, subject, priority, created_by)
		VALUES ($1, $2, $3, $4)
		RETURNING `+ticketCols, orgID, subject, priority, createdBy))
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO support_ticket_messages (ticket_id, author_user_id, body, staff)
		VALUES ($1, $2, $3, false)`, t.ID, createdBy, body); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	t.MessageCount = 1
	return t, nil
}

// ListTickets returns the org's tickets, newest activity first, with a message count.
func (s *Store) ListTickets(ctx context.Context, orgID uuid.UUID) ([]Ticket, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.id, t.subject, t.status, t.priority, t.created_by, t.created_at, t.updated_at,
		       (SELECT count(*) FROM support_ticket_messages m WHERE m.ticket_id = t.id)
		FROM support_tickets t
		WHERE t.organization_id = $1
		ORDER BY t.updated_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Ticket
	for rows.Next() {
		var t Ticket
		if err := rows.Scan(&t.ID, &t.Subject, &t.Status, &t.Priority, &t.CreatedBy,
			&t.CreatedAt, &t.UpdatedAt, &t.MessageCount); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetTicket returns a ticket with its full message thread, scoped to the org.
func (s *Store) GetTicket(ctx context.Context, orgID, id uuid.UUID) (*Ticket, error) {
	t, err := scanTicket(s.pool.QueryRow(ctx,
		`SELECT `+ticketCols+` FROM support_tickets WHERE id = $1 AND organization_id = $2`, id, orgID))
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, author_user_id, body, staff, created_at
		FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m TicketMessage
		if err := rows.Scan(&m.ID, &m.Author, &m.Body, &m.Staff, &m.CreatedAt); err != nil {
			return nil, err
		}
		t.Messages = append(t.Messages, m)
	}
	return t, rows.Err()
}

// AddTicketMessage appends a reply and bumps the ticket's activity timestamp;
// status is set to 'pending' on a customer reply and 'open' is left as-is.
func (s *Store) AddTicketMessage(ctx context.Context, orgID, ticketID, author uuid.UUID, body string, staff bool) (*TicketMessage, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		`UPDATE support_tickets SET updated_at = now() WHERE id = $1 AND organization_id = $2`, ticketID, orgID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	var m TicketMessage
	if err := tx.QueryRow(ctx, `
		INSERT INTO support_ticket_messages (ticket_id, author_user_id, body, staff)
		VALUES ($1, $2, $3, $4)
		RETURNING id, author_user_id, body, staff, created_at`,
		ticketID, author, body, staff).Scan(&m.ID, &m.Author, &m.Body, &m.Staff, &m.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &m, nil
}

// SetTicketStatus closes/reopens a ticket, scoped to the org.
func (s *Store) SetTicketStatus(ctx context.Context, orgID, id uuid.UUID, status string) (*Ticket, error) {
	return scanTicket(s.pool.QueryRow(ctx, `
		UPDATE support_tickets SET status = $3, updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING `+ticketCols, id, orgID, status))
}
