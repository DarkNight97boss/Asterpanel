package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// --- Websites -----------------------------------------------------------------

type CreateWebsiteParams struct {
	OrgID      uuid.UUID
	NodeID     uuid.NullUUID
	Name       string
	Runtime    string
	SSLEnabled bool
}

func (s *Store) CreateWebsite(ctx context.Context, p CreateWebsiteParams) (*Website, error) {
	const q = `
		INSERT INTO websites (organization_id, server_node_id, name, runtime, ssl_enabled)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, organization_id, server_node_id, primary_domain_id, name, runtime, runtime_version,
		          status, ssl_enabled, ssl_status, created_at`
	return scanWebsite(s.pool.QueryRow(ctx, q, p.OrgID, p.NodeID, p.Name, p.Runtime, p.SSLEnabled))
}

func (s *Store) GetWebsite(ctx context.Context, orgID, id uuid.UUID) (*Website, error) {
	const q = `
		SELECT id, organization_id, server_node_id, primary_domain_id, name, runtime, runtime_version,
		       status, ssl_enabled, ssl_status, created_at
		FROM websites WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`
	return scanWebsite(s.pool.QueryRow(ctx, q, id, orgID))
}

func (s *Store) ListWebsites(ctx context.Context, orgID uuid.UUID) ([]Website, error) {
	const q = `
		SELECT id, organization_id, server_node_id, primary_domain_id, name, runtime, runtime_version,
		       status, ssl_enabled, ssl_status, created_at
		FROM websites WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Website
	for rows.Next() {
		w, err := scanWebsite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *w)
	}
	return out, rows.Err()
}

func scanWebsite(row rowScanner) (*Website, error) {
	var w Website
	if err := row.Scan(&w.ID, &w.OrganizationID, &w.ServerNodeID, &w.PrimaryDomainID, &w.Name,
		&w.Runtime, &w.RuntimeVersion, &w.Status, &w.SSLEnabled, &w.SSLStatus, &w.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &w, nil
}

// SetWebsiteRuntime switches a site's runtime/version and marks it provisioning
// while the agent redeploys the container.
func (s *Store) SetWebsiteRuntime(ctx context.Context, id uuid.UUID, runtime string, version *string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE websites SET runtime = $2, runtime_version = $3, status = 'provisioning' WHERE id = $1`,
		id, runtime, version)
	return err
}

func (s *Store) SetWebsiteStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := s.pool.Exec(ctx, `UPDATE websites SET status = $2 WHERE id = $1`, id, status)
	return err
}

func (s *Store) SetWebsiteSSLStatus(ctx context.Context, id uuid.UUID, sslStatus string) error {
	_, err := s.pool.Exec(ctx, `UPDATE websites SET ssl_status = $2 WHERE id = $1`, id, sslStatus)
	return err
}

// RenameWebsite changes a website's display name (org-scoped).
func (s *Store) RenameWebsite(ctx context.Context, orgID, id uuid.UUID, name string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE websites SET name = $3 WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`, id, orgID, name)
	return err
}

// --- Applications & deployments ----------------------------------------------

type CreateApplicationParams struct {
	OrgID     uuid.UUID
	WebsiteID uuid.NullUUID
	NodeID    uuid.NullUUID
	Name      string
	Runtime   string
	RepoURL   *string
	Branch    string
}

func (s *Store) CreateApplication(ctx context.Context, p CreateApplicationParams) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO applications (organization_id, website_id, server_node_id, name, runtime, repo_url, repo_branch)
		VALUES ($1, $2, $3, $4, $5, $6, COALESCE(NULLIF($7,''),'main'))
		RETURNING id`,
		p.OrgID, p.WebsiteID, p.NodeID, p.Name, p.Runtime, p.RepoURL, p.Branch).Scan(&id)
	return id, err
}

// CreateDeployment creates the next sequential deployment for an application.
func (s *Store) CreateDeployment(ctx context.Context, orgID, appID uuid.UUID, sourceType, gitRef, trigger string, createdBy uuid.NullUUID) (uuid.UUID, int, error) {
	var id uuid.UUID
	var seq int
	err := s.pool.QueryRow(ctx, `
		INSERT INTO deployments (organization_id, application_id, sequence, trigger, source_type, git_ref, status)
		VALUES ($1, $2,
		        (SELECT COALESCE(MAX(sequence),0)+1 FROM deployments WHERE application_id = $2),
		        $3, $4, $5, 'queued')
		RETURNING id, sequence`,
		orgID, appID, trigger, sourceType, nullString(gitRef)).Scan(&id, &seq)
	return id, seq, err
}

func (s *Store) SetDeploymentStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := s.pool.Exec(ctx, `UPDATE deployments SET status = $2 WHERE id = $1`, id, status)
	return err
}

// MarkDeploymentCurrent atomically flips is_current to this deployment for its app.
func (s *Store) MarkDeploymentCurrent(ctx context.Context, appID, deploymentID uuid.UUID) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`UPDATE deployments SET is_current = false WHERE application_id = $1 AND is_current = true`, appID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`UPDATE deployments SET is_current = true, status = 'active' WHERE id = $1`, deploymentID)
		return err
	})
}
