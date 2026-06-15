package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type AccountMigration struct {
	ID             uuid.UUID
	SourceType     string
	SourceLabel    *string
	Status         string
	DomainsCount   int
	DatabasesCount int
	MailboxesCount int
	Plan           []byte // raw JSON
	Log            []byte // raw JSON
	CreatedAt      time.Time
	CompletedAt    *time.Time
}

type CreateMigrationParams struct {
	OrgID          uuid.UUID
	SourceType     string
	SourceLabel    string
	Plan           []byte
	DomainsCount   int
	DatabasesCount int
	MailboxesCount int
}

func (s *Store) CreateMigration(ctx context.Context, p CreateMigrationParams) (*AccountMigration, error) {
	planJSON := string(p.Plan)
	if planJSON == "" {
		planJSON = "{}"
	}
	var m AccountMigration
	err := s.pool.QueryRow(ctx, `
		INSERT INTO account_migrations (organization_id, source_type, source_label, plan, domains_count, databases_count, mailboxes_count)
		VALUES ($1, $2, NULLIF($3,''), $4::jsonb, $5, $6, $7)
		RETURNING id, source_type, source_label, status, domains_count, databases_count, mailboxes_count, plan, log, created_at, completed_at`,
		p.OrgID, p.SourceType, p.SourceLabel, planJSON, p.DomainsCount, p.DatabasesCount, p.MailboxesCount).
		Scan(&m.ID, &m.SourceType, &m.SourceLabel, &m.Status, &m.DomainsCount, &m.DatabasesCount,
			&m.MailboxesCount, &m.Plan, &m.Log, &m.CreatedAt, &m.CompletedAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

const migrationCols = `id, source_type, source_label, status, domains_count, databases_count,
	mailboxes_count, plan, log, created_at, completed_at`

func scanMigration(row rowScanner) (*AccountMigration, error) {
	var m AccountMigration
	if err := row.Scan(&m.ID, &m.SourceType, &m.SourceLabel, &m.Status, &m.DomainsCount,
		&m.DatabasesCount, &m.MailboxesCount, &m.Plan, &m.Log, &m.CreatedAt, &m.CompletedAt); err != nil {
		return nil, norows(err)
	}
	return &m, nil
}

func (s *Store) ListMigrations(ctx context.Context, orgID uuid.UUID) ([]AccountMigration, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+migrationCols+` FROM account_migrations WHERE organization_id = $1 ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AccountMigration
	for rows.Next() {
		m, err := scanMigration(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

func (s *Store) GetMigration(ctx context.Context, orgID, id uuid.UUID) (*AccountMigration, error) {
	return scanMigration(s.pool.QueryRow(ctx,
		`SELECT `+migrationCols+` FROM account_migrations WHERE id = $1 AND organization_id = $2`, id, orgID))
}

// UpdateMigration records a new status + log; when terminal, stamps completed_at.
func (s *Store) UpdateMigration(ctx context.Context, orgID, id uuid.UUID, status string, log []byte) error {
	logJSON := string(log)
	if logJSON == "" {
		logJSON = "[]"
	}
	terminal := status == "completed" || status == "failed"
	tag, err := s.pool.Exec(ctx, `
		UPDATE account_migrations
		SET status = $3, log = $4::jsonb,
		    completed_at = CASE WHEN $5 THEN now() ELSE completed_at END
		WHERE id = $1 AND organization_id = $2`, id, orgID, status, logJSON, terminal)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
