package store

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
)

const planColumns = `id, code, name, description, price_cents, currency, interval, limits, is_active, created_at, owner_org_id`

func scanPlan(row rowScanner) (*BillingPlan, error) {
	var p BillingPlan
	var raw []byte
	if err := row.Scan(&p.ID, &p.Code, &p.Name, &p.Description, &p.PriceCents, &p.Currency,
		&p.Interval, &raw, &p.IsActive, &p.CreatedAt, &p.OwnerOrgID); err != nil {
		return nil, norows(err)
	}
	p.Limits = map[string]int{}
	_ = json.Unmarshal(raw, &p.Limits)
	return &p, nil
}

// ListPlans returns the PLATFORM hosting packages (operator-managed, not owned
// by any reseller), active and inactive, cheapest first.
func (s *Store) ListPlans(ctx context.Context) ([]BillingPlan, error) {
	return s.scanPlanRows(ctx, `SELECT `+planColumns+` FROM billing_plans
		WHERE owner_org_id IS NULL ORDER BY price_cents, code`)
}

// ListPlansOwnedBy returns the packages a reseller has defined for its own
// customers (owner_org_id = the reseller).
func (s *Store) ListPlansOwnedBy(ctx context.Context, ownerOrgID uuid.UUID) ([]BillingPlan, error) {
	return s.scanPlanRows(ctx, `SELECT `+planColumns+` FROM billing_plans
		WHERE owner_org_id = $1 ORDER BY price_cents, code`, ownerOrgID)
}

func (s *Store) scanPlanRows(ctx context.Context, q string, args ...any) ([]BillingPlan, error) {
	rows, err := s.pool.Query(ctx, q, args...)
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

// CreatePlan inserts a hosting package. A NULL owner is a platform plan; a set
// owner makes it a reseller-owned template.
func (s *Store) CreatePlan(ctx context.Context, code, name string, desc *string, priceCents int, currency, interval string, limits map[string]int, owner uuid.NullUUID) (*BillingPlan, error) {
	raw, _ := json.Marshal(limits)
	return scanPlan(s.pool.QueryRow(ctx, `
		INSERT INTO billing_plans (code, name, description, price_cents, currency, interval, limits, owner_org_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING `+planColumns,
		code, name, desc, priceCents, currency, interval, string(raw), owner))
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

// DeletePlanOwnedBy deletes a plan only if it belongs to the given reseller, so
// a reseller can never remove a platform plan or another reseller's template.
func (s *Store) DeletePlanOwnedBy(ctx context.Context, id, ownerOrgID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM billing_plans WHERE id = $1 AND owner_org_id = $2`, id, ownerOrgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdatePlanOwnedBy edits the name and limits of a reseller-owned package, scoped
// to the owner (ErrNotFound if it isn't the reseller's own).
func (s *Store) UpdatePlanOwnedBy(ctx context.Context, id, ownerOrgID uuid.UUID, name string, limits map[string]int) (*BillingPlan, error) {
	raw, _ := json.Marshal(limits)
	return scanPlan(s.pool.QueryRow(ctx, `
		UPDATE billing_plans SET name = $3, limits = $4::jsonb
		WHERE id = $1 AND owner_org_id = $2
		RETURNING `+planColumns,
		id, ownerOrgID, name, string(raw)))
}

// SetOrgPlan assigns (or clears, when planID is invalid) an org's billing plan.
func (s *Store) SetOrgPlan(ctx context.Context, orgID uuid.UUID, planID uuid.NullUUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE organizations SET billing_plan_id = $2 WHERE id = $1`, orgID, planID)
	return err
}
