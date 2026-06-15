package store

import (
	"context"

	"github.com/google/uuid"
)

// ── Cron jobs ────────────────────────────────────────────────────────────────

func (s *Store) CreateCronJob(ctx context.Context, orgID uuid.UUID, schedule, command string) (*CronJob, error) {
	const q = `
		INSERT INTO cron_jobs (organization_id, schedule, command)
		VALUES ($1, $2, $3)
		RETURNING id, organization_id, schedule, command, enabled, last_run_at, last_status, created_at`
	return scanCron(s.pool.QueryRow(ctx, q, orgID, schedule, command))
}

func (s *Store) ListCronJobs(ctx context.Context, orgID uuid.UUID) ([]CronJob, error) {
	const q = `
		SELECT id, organization_id, schedule, command, enabled, last_run_at, last_status, created_at
		FROM cron_jobs WHERE organization_id = $1 ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CronJob
	for rows.Next() {
		c, err := scanCron(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

func (s *Store) DeleteCronJob(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM cron_jobs WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanCron(row rowScanner) (*CronJob, error) {
	var c CronJob
	if err := row.Scan(&c.ID, &c.OrganizationID, &c.Schedule, &c.Command, &c.Enabled,
		&c.LastRunAt, &c.LastStatus, &c.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &c, nil
}

// ── FTP/SFTP accounts ────────────────────────────────────────────────────────

type CreateFtpParams struct {
	ID                  uuid.UUID
	OrgID               uuid.UUID
	NodeID              uuid.NullUUID
	Username            string
	Protocol            string
	HomeDirectory       string
	CredentialsSecretID uuid.NullUUID
}

func (s *Store) CreateFtpAccount(ctx context.Context, p CreateFtpParams) (*FtpAccount, error) {
	if p.Protocol == "" {
		p.Protocol = "SFTP"
	}
	const q = `
		INSERT INTO ftp_accounts (id, organization_id, server_node_id, username, protocol, home_directory, credentials_secret_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, organization_id, username, protocol, home_directory, status, created_at`
	return scanFtp(s.pool.QueryRow(ctx, q, p.ID, p.OrgID, p.NodeID, p.Username, p.Protocol, p.HomeDirectory, p.CredentialsSecretID))
}

func (s *Store) ListFtpAccounts(ctx context.Context, orgID uuid.UUID) ([]FtpAccount, error) {
	const q = `
		SELECT id, organization_id, username, protocol, home_directory, status, created_at
		FROM ftp_accounts WHERE organization_id = $1 ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FtpAccount
	for rows.Next() {
		a, err := scanFtp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func (s *Store) DeleteFtpAccount(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM ftp_accounts WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanFtp(row rowScanner) (*FtpAccount, error) {
	var a FtpAccount
	if err := row.Scan(&a.ID, &a.OrganizationID, &a.Username, &a.Protocol, &a.HomeDirectory, &a.Status, &a.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &a, nil
}
