package store

import (
	"context"

	"github.com/google/uuid"
)

func (s *Store) CreateRemoteHost(ctx context.Context, orgID, databaseID uuid.UUID, host string) (*DBRemoteHost, error) {
	const q = `
		INSERT INTO db_remote_hosts (organization_id, database_id, host)
		VALUES ($1, $2, $3)
		RETURNING id, organization_id, database_id, host, created_at`
	return scanRemoteHost(s.pool.QueryRow(ctx, q, orgID, databaseID, host))
}

func (s *Store) ListRemoteHosts(ctx context.Context, orgID, databaseID uuid.UUID) ([]DBRemoteHost, error) {
	const q = `
		SELECT id, organization_id, database_id, host, created_at
		FROM db_remote_hosts WHERE organization_id = $1 AND database_id = $2 ORDER BY host`
	rows, err := s.pool.Query(ctx, q, orgID, databaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DBRemoteHost
	for rows.Next() {
		h, err := scanRemoteHost(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *h)
	}
	return out, rows.Err()
}

func (s *Store) DeleteRemoteHost(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM db_remote_hosts WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanRemoteHost(row rowScanner) (*DBRemoteHost, error) {
	var h DBRemoteHost
	if err := row.Scan(&h.ID, &h.OrganizationID, &h.DatabaseID, &h.Host, &h.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &h, nil
}
