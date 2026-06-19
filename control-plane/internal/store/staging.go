package store

import (
	"context"

	"github.com/google/uuid"
)

// UpsertStagingEnvironment creates (or re-arms) a site's staging environment and
// records the dispatched clone job. Status is reset to 'creating'; the agent's
// job callback flips it to 'ready' or 'error' via SyncStagingForJob.
func (s *Store) UpsertStagingEnvironment(ctx context.Context, orgID, websiteID uuid.UUID, jobID uuid.NullUUID) (*StagingEnvironment, error) {
	const q = `
		INSERT INTO staging_environments (organization_id, website_id, status, last_job_id)
		VALUES ($1, $2, 'creating', $3)
		ON CONFLICT (website_id) DO UPDATE SET status = 'creating', last_job_id = EXCLUDED.last_job_id
		RETURNING id, organization_id, website_id, status, last_job_id, last_synced_at, created_at`
	return scanStaging(s.pool.QueryRow(ctx, q, orgID, websiteID, jobID))
}

func (s *Store) GetStagingBySite(ctx context.Context, orgID, websiteID uuid.UUID) (*StagingEnvironment, error) {
	const q = `
		SELECT id, organization_id, website_id, status, last_job_id, last_synced_at, created_at
		FROM staging_environments WHERE organization_id = $1 AND website_id = $2`
	return scanStaging(s.pool.QueryRow(ctx, q, orgID, websiteID))
}

// SetStagingJob transitions an existing environment to a new state (e.g.
// 'promoting') and links the dispatched job so its callback can finalize it.
func (s *Store) SetStagingJob(ctx context.Context, orgID, websiteID uuid.UUID, status string, jobID uuid.NullUUID) (*StagingEnvironment, error) {
	const q = `
		UPDATE staging_environments SET status = $3, last_job_id = $4
		WHERE organization_id = $1 AND website_id = $2
		RETURNING id, organization_id, website_id, status, last_job_id, last_synced_at, created_at`
	return scanStaging(s.pool.QueryRow(ctx, q, orgID, websiteID, status, jobID))
}

// SyncStagingForJob is called from the agent job-status callback: it finalizes the
// staging environment whose most recent job just completed. A no-op for any job
// not linked to a staging environment.
func (s *Store) SyncStagingForJob(ctx context.Context, jobID uuid.UUID, jobStatus string) error {
	const q = `
		UPDATE staging_environments
		SET status = CASE
		        WHEN $2 = 'succeeded' THEN 'ready'
		        WHEN $2 IN ('failed', 'expired', 'canceled') THEN 'error'
		        ELSE status END,
		    last_synced_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE last_synced_at END
		WHERE last_job_id = $1`
	_, err := s.pool.Exec(ctx, q, jobID, jobStatus)
	return err
}

func (s *Store) DeleteStaging(ctx context.Context, orgID, websiteID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM staging_environments WHERE organization_id = $1 AND website_id = $2`, orgID, websiteID)
	return err
}

func scanStaging(row rowScanner) (*StagingEnvironment, error) {
	var e StagingEnvironment
	if err := row.Scan(&e.ID, &e.OrganizationID, &e.WebsiteID, &e.Status, &e.LastJobID, &e.LastSyncedAt, &e.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &e, nil
}
