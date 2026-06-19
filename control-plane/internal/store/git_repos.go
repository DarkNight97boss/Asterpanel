package store

import (
	"context"

	"github.com/google/uuid"
)

// UpsertGitRepo enables (or re-points) git push-to-deploy for a website.
func (s *Store) UpsertGitRepo(ctx context.Context, orgID, websiteID uuid.UUID, branch, cloneURL string) (*GitRepo, error) {
	const q = `
		INSERT INTO git_repos (organization_id, website_id, branch, clone_url)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (website_id) DO UPDATE SET branch = EXCLUDED.branch, clone_url = EXCLUDED.clone_url
		RETURNING id, organization_id, website_id, branch, clone_url, created_at`
	return scanGitRepo(s.pool.QueryRow(ctx, q, orgID, websiteID, branch, cloneURL))
}

func (s *Store) GetGitRepoBySite(ctx context.Context, orgID, websiteID uuid.UUID) (*GitRepo, error) {
	const q = `
		SELECT id, organization_id, website_id, branch, clone_url, created_at
		FROM git_repos WHERE organization_id = $1 AND website_id = $2`
	return scanGitRepo(s.pool.QueryRow(ctx, q, orgID, websiteID))
}

func (s *Store) DeleteGitRepo(ctx context.Context, orgID, websiteID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM git_repos WHERE organization_id = $1 AND website_id = $2`, orgID, websiteID)
	return err
}

func scanGitRepo(row rowScanner) (*GitRepo, error) {
	var g GitRepo
	if err := row.Scan(&g.ID, &g.OrganizationID, &g.WebsiteID, &g.Branch, &g.CloneURL, &g.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &g, nil
}
