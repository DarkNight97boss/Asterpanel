package store

import (
	"context"

	"github.com/google/uuid"
)

const appColumns = `id, organization_id, website_id, server_node_id, name, runtime,
	repo_url, COALESCE(repo_branch, 'main'), install_command, build_command, start_command,
	status, created_at`

func scanApplication(row rowScanner) (*Application, error) {
	var a Application
	if err := row.Scan(&a.ID, &a.OrganizationID, &a.WebsiteID, &a.ServerNodeID, &a.Name, &a.Runtime,
		&a.RepoURL, &a.RepoBranch, &a.InstallCommand, &a.BuildCommand, &a.StartCommand,
		&a.Status, &a.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &a, nil
}

func (s *Store) ListApplications(ctx context.Context, orgID uuid.UUID) ([]Application, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+appColumns+`
		FROM applications WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Application
	for rows.Next() {
		a, err := scanApplication(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func (s *Store) GetApplication(ctx context.Context, orgID, id uuid.UUID) (*Application, error) {
	return scanApplication(s.pool.QueryRow(ctx, `SELECT `+appColumns+`
		FROM applications WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`, orgID, id))
}

// UpdateApplicationConfig updates the build/run command triplet. nil leaves a
// field unchanged; an empty (non-nil) string clears it.
func (s *Store) UpdateApplicationConfig(ctx context.Context, orgID, id uuid.UUID, install, build, start *string) (*Application, error) {
	return scanApplication(s.pool.QueryRow(ctx, `
		UPDATE applications SET
			install_command = COALESCE($3, install_command),
			build_command   = COALESCE($4, build_command),
			start_command   = COALESCE($5, start_command)
		WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
		RETURNING `+appColumns, orgID, id, install, build, start))
}

// CreateApplicationFull inserts an application with its repo configuration and
// returns the full row.
func (s *Store) CreateApplicationFull(ctx context.Context, p CreateApplicationParams) (*Application, error) {
	return scanApplication(s.pool.QueryRow(ctx, `
		INSERT INTO applications (organization_id, website_id, server_node_id, name, runtime, repo_url, repo_branch)
		VALUES ($1, $2, $3, $4, $5, $6, COALESCE(NULLIF($7,''),'main'))
		RETURNING `+appColumns,
		p.OrgID, p.WebsiteID, p.NodeID, p.Name, p.Runtime, p.RepoURL, p.Branch))
}

// --- per-application environment variables ----------------------------------

func (s *Store) ListAppEnvVars(ctx context.Context, orgID, appID uuid.UUID) ([]EnvVar, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, organization_id, key, value, is_build_time, created_at
		FROM environment_variables
		WHERE organization_id = $1 AND application_id = $2 ORDER BY key`, orgID, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EnvVar
	for rows.Next() {
		var e EnvVar
		if err := rows.Scan(&e.ID, &e.OrganizationID, &e.Key, &e.Value, &e.IsBuildTime, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) UpsertAppEnvVar(ctx context.Context, orgID, appID uuid.UUID, key, value string, buildTime bool) (*EnvVar, error) {
	const q = `
		INSERT INTO environment_variables (organization_id, application_id, key, value, is_build_time)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (application_id, key)
		DO UPDATE SET value = EXCLUDED.value, is_build_time = EXCLUDED.is_build_time
		RETURNING id, organization_id, key, value, is_build_time, created_at`
	var e EnvVar
	if err := s.pool.QueryRow(ctx, q, orgID, appID, key, value, buildTime).
		Scan(&e.ID, &e.OrganizationID, &e.Key, &e.Value, &e.IsBuildTime, &e.CreatedAt); err != nil {
		return nil, err
	}
	return &e, nil
}

func (s *Store) DeleteAppEnvVar(ctx context.Context, orgID, appID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM environment_variables WHERE id = $1 AND organization_id = $2 AND application_id = $3`,
		id, orgID, appID)
	return err
}
