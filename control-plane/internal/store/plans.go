package store

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
)

const planColumns = `id, code, name, description, price_cents, currency, interval, limits, is_active, created_at`

func scanPlan(row rowScanner) (*BillingPlan, error) {
	var p BillingPlan
	var raw []byte
	if err := row.Scan(&p.ID, &p.Code, &p.Name, &p.Description, &p.PriceCents, &p.Currency,
		&p.Interval, &raw, &p.IsActive, &p.CreatedAt); err != nil {
		return nil, norows(err)
	}
	p.Limits = map[string]int{}
	_ = json.Unmarshal(raw, &p.Limits)
	return &p, nil
}

// ListPlans returns every hosting package (active and inactive), cheapest first.
func (s *Store) ListPlans(ctx context.Context) ([]BillingPlan, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+planColumns+` FROM billing_plans ORDER BY price_cents, code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BillingPlan
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

func (s *Store) GetPlan(ctx context.Context, id uuid.UUID) (*BillingPlan, error) {
	return scanPlan(s.pool.QueryRow(ctx, `SELECT `+planColumns+` FROM billing_plans WHERE id = $1`, id))
}

func (s *Store) CreatePlan(ctx context.Context, code, name string, desc *string, priceCents int, currency, interval string, limits map[string]int) (*BillingPlan, error) {
	raw, _ := json.Marshal(limits)
	return scanPlan(s.pool.QueryRow(ctx, `
		INSERT INTO billing_plans (code, name, description, price_cents, currency, interval, limits)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING `+planColumns,
		code, name, desc, priceCents, currency, interval, string(raw)))
}

// UpdatePlan patches a plan. nil arguments leave the field unchanged; limitsJSON
// (a JSON object string) replaces the whole limits map when non-nil.
func (s *Store) UpdatePlan(ctx context.Context, id uuid.UUID, name, desc *string, priceCents *int, limitsJSON *string, isActive *bool) (*BillingPlan, error) {
	return scanPlan(s.pool.QueryRow(ctx, `
		UPDATE billing_plans SET
			name        = COALESCE($2, name),
			description = COALESCE($3, description),
			price_cents = COALESCE($4, price_cents),
			limits      = COALESCE($5::jsonb, limits),
			is_active   = COALESCE($6, is_active)
		WHERE id = $1
		RETURNING `+planColumns,
		id, name, desc, priceCents, limitsJSON, isActive))
}

func (s *Store) DeletePlan(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM billing_plans WHERE id = $1`, id)
	return err
}

// SetOrgPlan assigns (or clears, when planID is invalid) an org's billing plan.
func (s *Store) SetOrgPlan(ctx context.Context, orgID uuid.UUID, planID uuid.NullUUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE organizations SET billing_plan_id = $2 WHERE id = $1`, orgID, planID)
	return err
}
