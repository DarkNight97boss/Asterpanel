package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// GetPlanIDByCode resolves an active billing plan id from its code.
func (s *Store) GetPlanIDByCode(ctx context.Context, code string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM billing_plans WHERE code = $1 AND is_active`, code).Scan(&id)
	return id, norows(err)
}

// MarkReseller flags an org as a reseller (it has at least one sub-account).
func (s *Store) MarkReseller(ctx context.Context, orgID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE organizations SET is_reseller = true WHERE id = $1`, orgID)
	return err
}

type ProvisionSubAccountParams struct {
	Name              string
	Slug              string
	ParentOrgID       uuid.UUID
	PlanID            uuid.NullUUID
	OwnerEmail        string
	OwnerFullName     string
	OwnerPasswordHash string
	OwnerRoleID       uuid.UUID
}

// ProvisionSubAccount creates a child organization, its owner user, and the
// owner membership in a single transaction.
func (s *Store) ProvisionSubAccount(ctx context.Context, p ProvisionSubAccountParams) (*Organization, uuid.UUID, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, uuid.Nil, err
	}
	defer tx.Rollback(ctx)

	var org Organization
	if err := tx.QueryRow(ctx, `
		INSERT INTO organizations (slug, name, parent_org_id, billing_plan_id)
		VALUES ($1, $2, $3, $4)
		RETURNING id, slug, name, status, billing_plan_id, created_at`,
		p.Slug, p.Name, p.ParentOrgID, p.PlanID).
		Scan(&org.ID, &org.Slug, &org.Name, &org.Status, &org.BillingPlanID, &org.CreatedAt); err != nil {
		return nil, uuid.Nil, err
	}

	var userID uuid.UUID
	if err := tx.QueryRow(ctx, `
		INSERT INTO users (email, password_hash, full_name, is_superadmin, email_verified_at)
		VALUES ($1, $2, $3, false, now())
		RETURNING id`, p.OwnerEmail, p.OwnerPasswordHash, p.OwnerFullName).Scan(&userID); err != nil {
		return nil, uuid.Nil, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO memberships (user_id, organization_id, role_id, status)
		VALUES ($1, $2, $3, 'active')`, userID, org.ID, p.OwnerRoleID); err != nil {
		return nil, uuid.Nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, uuid.Nil, err
	}
	return &org, userID, nil
}

type SubAccount struct {
	ID        uuid.UUID
	Name      string
	Slug      string
	Status    string
	PlanCode  *string
	Sites     int
	CreatedAt time.Time
}

// ListSubAccounts returns the child orgs of a reseller with their plan + site count.
func (s *Store) ListSubAccounts(ctx context.Context, parentOrgID uuid.UUID) ([]SubAccount, error) {
	const q = `
		SELECT o.id, o.name, o.slug, o.status, bp.code,
		       (SELECT count(*) FROM websites w WHERE w.organization_id = o.id AND w.deleted_at IS NULL),
		       o.created_at
		FROM organizations o
		LEFT JOIN billing_plans bp ON bp.id = o.billing_plan_id
		WHERE o.parent_org_id = $1 AND o.deleted_at IS NULL
		ORDER BY o.created_at DESC`
	rows, err := s.pool.Query(ctx, q, parentOrgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SubAccount
	for rows.Next() {
		var a SubAccount
		if err := rows.Scan(&a.ID, &a.Name, &a.Slug, &a.Status, &a.PlanCode, &a.Sites, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountSubAccounts is used to enforce a reseller's sub-account quota.
func (s *Store) CountSubAccounts(ctx context.Context, parentOrgID uuid.UUID) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM organizations WHERE parent_org_id = $1 AND deleted_at IS NULL`, parentOrgID).Scan(&n)
	return n, err
}

// SetSubAccountStatus suspends/reactivates a child org, scoped to its parent.
func (s *Store) SetSubAccountStatus(ctx context.Context, parentOrgID, id uuid.UUID, status string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE organizations SET status = $3 WHERE id = $1 AND parent_org_id = $2`, id, parentOrgID, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
