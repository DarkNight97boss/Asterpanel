package store

import (
	"context"

	"github.com/google/uuid"
)

func (s *Store) CreateDdnsHost(ctx context.Context, orgID, domainID uuid.UUID, name, token string) (*DdnsHost, error) {
	const q = `
		INSERT INTO ddns_hosts (organization_id, domain_id, name, token)
		VALUES ($1, $2, $3, $4)
		RETURNING id, organization_id, domain_id, name, token, last_ip, updated_at, created_at`
	return scanDdns(s.pool.QueryRow(ctx, q, orgID, domainID, name, token))
}

func (s *Store) ListDdnsHosts(ctx context.Context, orgID uuid.UUID) ([]DdnsHost, error) {
	const q = `
		SELECT id, organization_id, domain_id, name, token, last_ip, updated_at, created_at
		FROM ddns_hosts WHERE organization_id = $1 ORDER BY name`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DdnsHost
	for rows.Next() {
		h, err := scanDdns(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *h)
	}
	return out, rows.Err()
}

// GetDdnsByToken resolves the update token to its host (used by the public,
// token-authenticated update endpoint).
func (s *Store) GetDdnsByToken(ctx context.Context, token string) (*DdnsHost, error) {
	const q = `
		SELECT id, organization_id, domain_id, name, token, last_ip, updated_at, created_at
		FROM ddns_hosts WHERE token = $1`
	return scanDdns(s.pool.QueryRow(ctx, q, token))
}

func (s *Store) UpdateDdnsIP(ctx context.Context, id uuid.UUID, ip string) error {
	_, err := s.pool.Exec(ctx, `UPDATE ddns_hosts SET last_ip = $1, updated_at = now() WHERE id = $2`, ip, id)
	return err
}

func (s *Store) DeleteDdnsHost(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM ddns_hosts WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanDdns(row rowScanner) (*DdnsHost, error) {
	var h DdnsHost
	if err := row.Scan(&h.ID, &h.OrganizationID, &h.DomainID, &h.Name, &h.Token, &h.LastIP, &h.UpdatedAt, &h.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &h, nil
}
