package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// GetOrgPlanLimits returns the organization's plan code and its numeric limits
// (e.g. {"max_sites":25}). Returns ("", nil, nil) when the org has no plan
// (treated as unlimited by callers).
func (s *Store) GetOrgPlanLimits(ctx context.Context, orgID uuid.UUID) (string, map[string]int, error) {
	var code string
	var raw []byte
	err := s.pool.QueryRow(ctx, `
		SELECT bp.code, bp.limits
		FROM organizations o JOIN billing_plans bp ON bp.id = o.billing_plan_id
		WHERE o.id = $1`, orgID).Scan(&code, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	limits := map[string]int{}
	_ = json.Unmarshal(raw, &limits)
	return code, limits, nil
}

// UsageCounts returns the org's current resource usage by category.
func (s *Store) UsageCounts(ctx context.Context, orgID uuid.UUID) (map[string]int, error) {
	queries := map[string]string{
		"sites":     `SELECT count(*) FROM websites WHERE organization_id = $1 AND deleted_at IS NULL`,
		"domains":   `SELECT count(*) FROM domains WHERE organization_id = $1 AND deleted_at IS NULL`,
		"databases": `SELECT count(*) FROM database_instances WHERE organization_id = $1 AND deleted_at IS NULL`,
		"nodes":     `SELECT count(*) FROM server_nodes WHERE organization_id = $1 AND deleted_at IS NULL`,
		"mailboxes": `SELECT count(*) FROM mailboxes WHERE organization_id = $1`,
	}
	out := make(map[string]int, len(queries))
	for k, q := range queries {
		var n int
		if err := s.pool.QueryRow(ctx, q, orgID).Scan(&n); err != nil {
			return nil, err
		}
		out[k] = n
	}
	return out, nil
}
