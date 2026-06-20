package store

import (
	"context"
	"encoding/json"
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
	ID          uuid.UUID
	Name        string
	Slug        string
	Status      string
	PlanCode    *string
	Sites       int
	CreatedAt   time.Time
	OwnerUserID uuid.NullUUID
	OwnerEmail  *string
}

// ListSubAccounts returns the child orgs of a reseller with their plan, site
// count and owner (the oldest member — used as the impersonation target).
func (s *Store) ListSubAccounts(ctx context.Context, parentOrgID uuid.UUID) ([]SubAccount, error) {
	const q = `
		SELECT o.id, o.name, o.slug, o.status, bp.code,
		       (SELECT count(*) FROM websites w WHERE w.organization_id = o.id AND w.deleted_at IS NULL),
		       o.created_at, owner.user_id, owner.email
		FROM organizations o
		LEFT JOIN billing_plans bp ON bp.id = o.billing_plan_id
		LEFT JOIN LATERAL (
		    SELECT u.id AS user_id, u.email
		    FROM memberships m JOIN users u ON u.id = m.user_id
		    WHERE m.organization_id = o.id AND u.deleted_at IS NULL
		    ORDER BY u.created_at
		    LIMIT 1
		) owner ON true
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
		if err := rows.Scan(&a.ID, &a.Name, &a.Slug, &a.Status, &a.PlanCode, &a.Sites, &a.CreatedAt,
			&a.OwnerUserID, &a.OwnerEmail); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// IsSubAccountOf reports whether child is a non-deleted sub-account of parent.
func (s *Store) IsSubAccountOf(ctx context.Context, child, parent uuid.UUID) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM organizations WHERE id = $1 AND parent_org_id = $2 AND deleted_at IS NULL)`,
		child, parent).Scan(&ok)
	return ok, err
}

// IsDescendantOf reports whether descendant sits anywhere under ancestor in the
// reseller tree (any depth), walking parent_org_id recursively. This is the
// multi-tier generalisation of IsSubAccountOf: a master reseller authorises over
// its whole subtree, not just its direct children. A depth cap guards against a
// pathological cycle (parents are only ever set to pre-existing orgs, so cycles
// shouldn't arise, but the cap keeps the walk bounded regardless).
func (s *Store) IsDescendantOf(ctx context.Context, descendant, ancestor uuid.UUID) (bool, error) {
	if descendant == ancestor {
		return false, nil
	}
	const q = `
		WITH RECURSIVE chain AS (
			SELECT id, parent_org_id, 1 AS depth
			FROM organizations WHERE id = $1 AND deleted_at IS NULL
			UNION ALL
			SELECT o.id, o.parent_org_id, c.depth + 1
			FROM organizations o
			JOIN chain c ON o.id = c.parent_org_id
			WHERE o.deleted_at IS NULL AND c.depth < 64
		)
		SELECT EXISTS(SELECT 1 FROM chain WHERE parent_org_id = $2)`
	var ok bool
	err := s.pool.QueryRow(ctx, q, descendant, ancestor).Scan(&ok)
	return ok, err
}

// SumSubAccountPlanLimits sums the plan limit maps of a reseller's direct
// sub-accounts (optionally excluding one being re-planned), so the overselling
// guard can check that the parent isn't allocating more than its own plan
// grants. Sub-accounts without a plan contribute nothing (they are handled
// separately as an "unlimited child" by the guard).
func (s *Store) SumSubAccountPlanLimits(ctx context.Context, parentOrgID uuid.UUID, except uuid.NullUUID) (map[string]int, error) {
	const q = `
		SELECT bp.limits
		FROM organizations o
		JOIN billing_plans bp ON bp.id = o.billing_plan_id
		WHERE o.parent_org_id = $1 AND o.deleted_at IS NULL
		  AND ($2::uuid IS NULL OR o.id <> $2)`
	rows, err := s.pool.Query(ctx, q, parentOrgID, except)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sum := map[string]int{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		m := map[string]int{}
		_ = json.Unmarshal(raw, &m)
		for k, v := range m {
			sum[k] += v
		}
	}
	return sum, rows.Err()
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
