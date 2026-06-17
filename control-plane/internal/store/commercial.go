package store

import (
	"context"

	"github.com/google/uuid"
)

// ── SSL certificates ─────────────────────────────────────────────────────────

func (s *Store) CreateCertificate(ctx context.Context, orgID uuid.UUID, domainID uuid.NullUUID, domain string) (*Certificate, error) {
	const q = `
		INSERT INTO ssl_certificates (organization_id, domain_id, domain)
		VALUES ($1, $2, $3)
		RETURNING id, organization_id, domain_id, domain, issuer, status, auto_renew, expires_at, created_at`
	return scanCert(s.pool.QueryRow(ctx, q, orgID, domainID, domain))
}

func (s *Store) ListCertificates(ctx context.Context, orgID uuid.UUID) ([]Certificate, error) {
	const q = `
		SELECT id, organization_id, domain_id, domain, issuer, status, auto_renew, expires_at, created_at
		FROM ssl_certificates WHERE organization_id = $1 ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Certificate
	for rows.Next() {
		c, err := scanCert(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

func scanCert(row rowScanner) (*Certificate, error) {
	var c Certificate
	if err := row.Scan(&c.ID, &c.OrganizationID, &c.DomainID, &c.Domain, &c.Issuer, &c.Status,
		&c.AutoRenew, &c.ExpiresAt, &c.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &c, nil
}

// ── Mailboxes ────────────────────────────────────────────────────────────────

type CreateMailboxParams struct {
	ID                  uuid.UUID
	OrgID               uuid.UUID
	NodeID              uuid.NullUUID
	Address             string
	QuotaMB             int
	CredentialsSecretID uuid.NullUUID
}

func (s *Store) CreateMailbox(ctx context.Context, p CreateMailboxParams) (*Mailbox, error) {
	if p.QuotaMB <= 0 {
		p.QuotaMB = 1024
	}
	const q = `
		INSERT INTO mailboxes (id, organization_id, server_node_id, address, quota_mb, credentials_secret_id)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, organization_id, address, quota_mb, used_mb, status, created_at`
	return scanMailbox(s.pool.QueryRow(ctx, q, p.ID, p.OrgID, p.NodeID, p.Address, p.QuotaMB, p.CredentialsSecretID))
}

func (s *Store) ListMailboxes(ctx context.Context, orgID uuid.UUID) ([]Mailbox, error) {
	const q = `
		SELECT id, organization_id, address, quota_mb, used_mb, status, created_at
		FROM mailboxes WHERE organization_id = $1 ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Mailbox
	for rows.Next() {
		m, err := scanMailbox(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

func scanMailbox(row rowScanner) (*Mailbox, error) {
	var m Mailbox
	if err := row.Scan(&m.ID, &m.OrganizationID, &m.Address, &m.QuotaMB, &m.UsedMB, &m.Status, &m.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &m, nil
}

// GetMailboxAuth returns a mailbox's address and the id of the secret holding
// its (encrypted) password, scoped to the organization.
func (s *Store) GetMailboxAuth(ctx context.Context, orgID, id uuid.UUID) (string, uuid.NullUUID, error) {
	var address string
	var secretID uuid.NullUUID
	err := s.pool.QueryRow(ctx,
		`SELECT address, credentials_secret_id FROM mailboxes WHERE id = $1 AND organization_id = $2`,
		id, orgID).Scan(&address, &secretID)
	return address, secretID, norows(err)
}

// GetSecretByID returns the ciphertext/nonce/key id of a stored secret.
func (s *Store) GetSecretByID(ctx context.Context, id uuid.UUID) (ciphertext, nonce []byte, keyID string, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT ciphertext, nonce, key_id FROM secrets WHERE id = $1`, id).Scan(&ciphertext, &nonce, &keyID)
	return ciphertext, nonce, keyID, norows(err)
}

// ── Backups & restore ────────────────────────────────────────────────────────

func (s *Store) CreateBackup(ctx context.Context, orgID uuid.UUID, appID uuid.NullUUID, btype, trigger, storage string) (*Backup, error) {
	const q = `
		INSERT INTO backups (organization_id, application_id, type, trigger, storage_backend)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, organization_id, application_id, type, trigger, status, storage_backend, size_bytes, checksum, created_at`
	return scanBackup(s.pool.QueryRow(ctx, q, orgID, appID, btype, trigger, storage))
}

func (s *Store) ListBackups(ctx context.Context, orgID uuid.UUID) ([]Backup, error) {
	const q = `
		SELECT id, organization_id, application_id, type, trigger, status, storage_backend, size_bytes, checksum, created_at
		FROM backups WHERE organization_id = $1 ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Backup
	for rows.Next() {
		b, err := scanBackup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *b)
	}
	return out, rows.Err()
}

func (s *Store) GetBackup(ctx context.Context, orgID, id uuid.UUID) (*Backup, error) {
	const q = `
		SELECT id, organization_id, application_id, type, trigger, status, storage_backend, size_bytes, checksum, created_at
		FROM backups WHERE id = $1 AND organization_id = $2`
	return scanBackup(s.pool.QueryRow(ctx, q, id, orgID))
}

func (s *Store) CreateRestoreJob(ctx context.Context, orgID, backupID uuid.UUID, targetAppID uuid.NullUUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO restore_jobs (organization_id, backup_id, target_application_id)
		VALUES ($1, $2, $3) RETURNING id`, orgID, backupID, targetAppID).Scan(&id)
	return id, err
}

func scanBackup(row rowScanner) (*Backup, error) {
	var b Backup
	if err := row.Scan(&b.ID, &b.OrganizationID, &b.ApplicationID, &b.Type, &b.Trigger, &b.Status,
		&b.StorageBackend, &b.SizeBytes, &b.Checksum, &b.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &b, nil
}

// SetBackupJob links a backup row to the job that produces it, so the job-status
// callback can complete the backup (size, checksum, status) by job id.
func (s *Store) SetBackupJob(ctx context.Context, backupID, jobID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE backups SET job_id = $2, status = 'running', started_at = now(), updated_at = now() WHERE id = $1`,
		backupID, jobID)
	return err
}

// CompleteBackupForJob finalizes the backup linked to a job from its agent
// result: completed/failed status, byte size, integrity checksum.
func (s *Store) CompleteBackupForJob(ctx context.Context, jobID uuid.UUID, status string, sizeBytes int64, checksum string) error {
	var st string
	switch status {
	case "succeeded":
		st = "completed"
	case "failed", "expired", "canceled":
		st = "failed"
	default:
		return nil // intermediate status; nothing to finalize
	}
	var sz *int64
	if sizeBytes > 0 {
		sz = &sizeBytes
	}
	var cs *string
	if checksum != "" {
		cs = &checksum
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE backups
		SET status = $2, size_bytes = COALESCE($3, size_bytes), checksum = COALESCE($4, checksum),
		    completed_at = now(), updated_at = now()
		WHERE job_id = $1`, jobID, st, sz, cs)
	return err
}
