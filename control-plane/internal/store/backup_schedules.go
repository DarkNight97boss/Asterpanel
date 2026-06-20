package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type BackupSchedule struct {
	ID            uuid.UUID
	OrgID         uuid.UUID
	Frequency     string
	RetentionDays int
	Enabled       bool
	LastRunAt     *time.Time
	CreatedAt     time.Time
}

func (s *Store) CreateBackupSchedule(ctx context.Context, orgID uuid.UUID, frequency string, retentionDays int) (*BackupSchedule, error) {
	// last_run_at starts at now() so the first run happens after a full interval.
	const q = `
		INSERT INTO backup_schedules (organization_id, frequency, retention_days, last_run_at)
		VALUES ($1, $2, $3, now())
		RETURNING id, organization_id, frequency, retention_days, enabled, last_run_at, created_at`
	var b BackupSchedule
	err := s.pool.QueryRow(ctx, q, orgID, frequency, retentionDays).
		Scan(&b.ID, &b.OrgID, &b.Frequency, &b.RetentionDays, &b.Enabled, &b.LastRunAt, &b.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func (s *Store) ListBackupSchedules(ctx context.Context, orgID uuid.UUID) ([]BackupSchedule, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, organization_id, frequency, retention_days, enabled, last_run_at, created_at
		FROM backup_schedules WHERE organization_id = $1 ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BackupSchedule
	for rows.Next() {
		var b BackupSchedule
		if err := rows.Scan(&b.ID, &b.OrgID, &b.Frequency, &b.RetentionDays, &b.Enabled, &b.LastRunAt, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// UpdateBackupSchedule edits a schedule's frequency, retention and enabled flag.
func (s *Store) UpdateBackupSchedule(ctx context.Context, orgID, id uuid.UUID, frequency string, retentionDays int, enabled bool) (*BackupSchedule, error) {
	const q = `
		UPDATE backup_schedules SET frequency = $3, retention_days = $4, enabled = $5
		WHERE id = $1 AND organization_id = $2
		RETURNING id, organization_id, frequency, retention_days, enabled, last_run_at, created_at`
	var b BackupSchedule
	if err := s.pool.QueryRow(ctx, q, id, orgID, frequency, retentionDays, enabled).
		Scan(&b.ID, &b.OrgID, &b.Frequency, &b.RetentionDays, &b.Enabled, &b.LastRunAt, &b.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &b, nil
}

func (s *Store) DeleteBackupSchedule(ctx context.Context, orgID, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM backup_schedules WHERE id = $1 AND organization_id = $2`, id, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DueBackupSchedules returns enabled schedules whose interval has elapsed
// (daily = 24h, weekly = 7d) — the input to the background backup runner.
func (s *Store) DueBackupSchedules(ctx context.Context) ([]BackupSchedule, error) {
	const q = `
		SELECT id, organization_id, frequency, retention_days, enabled, last_run_at, created_at
		FROM backup_schedules
		WHERE enabled AND (
			last_run_at IS NULL
			OR (frequency = 'daily'  AND last_run_at < now() - interval '24 hours')
			OR (frequency = 'weekly' AND last_run_at < now() - interval '7 days')
		)`
	rows, err := s.pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BackupSchedule
	for rows.Next() {
		var b BackupSchedule
		if err := rows.Scan(&b.ID, &b.OrgID, &b.Frequency, &b.RetentionDays, &b.Enabled, &b.LastRunAt, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) MarkBackupScheduleRun(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE backup_schedules SET last_run_at = now() WHERE id = $1`, id)
	return err
}
