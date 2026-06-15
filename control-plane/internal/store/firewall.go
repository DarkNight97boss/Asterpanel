package store

import (
	"context"

	"github.com/google/uuid"
)

func (s *Store) CreateFirewallRule(ctx context.Context, orgID uuid.UUID, nodeID uuid.NullUUID, action, source, port string, note *string) (*FirewallRule, error) {
	if port == "" {
		port = "*"
	}
	const q = `
		INSERT INTO firewall_rules (organization_id, server_node_id, action, source, port, note)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, organization_id, action, source, port, note, created_at`
	return scanFirewall(s.pool.QueryRow(ctx, q, orgID, nodeID, action, source, port, note))
}

func (s *Store) ListFirewallRules(ctx context.Context, orgID uuid.UUID) ([]FirewallRule, error) {
	const q = `
		SELECT id, organization_id, action, source, port, note, created_at
		FROM firewall_rules WHERE organization_id = $1 ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FirewallRule
	for rows.Next() {
		r, err := scanFirewall(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (s *Store) DeleteFirewallRule(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM firewall_rules WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

func scanFirewall(row rowScanner) (*FirewallRule, error) {
	var r FirewallRule
	if err := row.Scan(&r.ID, &r.OrganizationID, &r.Action, &r.Source, &r.Port, &r.Note, &r.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &r, nil
}
