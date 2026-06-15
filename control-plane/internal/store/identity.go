package store

import (
	"context"

	"github.com/google/uuid"
)

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	const q = `
		SELECT id, email, email_verified_at, password_hash, full_name, status,
		       failed_login_count, locked_until, is_superadmin, last_login_at, created_at, updated_at
		FROM users WHERE email = $1 AND deleted_at IS NULL`
	return scanUser(s.pool.QueryRow(ctx, q, email))
}

func (s *Store) GetUserByID(ctx context.Context, id uuid.UUID) (*User, error) {
	const q = `
		SELECT id, email, email_verified_at, password_hash, full_name, status,
		       failed_login_count, locked_until, is_superadmin, last_login_at, created_at, updated_at
		FROM users WHERE id = $1 AND deleted_at IS NULL`
	return scanUser(s.pool.QueryRow(ctx, q, id))
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanUser(row rowScanner) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.EmailVerifiedAt, &u.PasswordHash, &u.FullName, &u.Status,
		&u.FailedLoginCount, &u.LockedUntil, &u.IsSuperadmin, &u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, norows(err)
	}
	return &u, nil
}

// CreateUser inserts a user with an already-hashed password.
func (s *Store) CreateUser(ctx context.Context, email, passwordHash string, fullName string, superadmin bool) (*User, error) {
	const q = `
		INSERT INTO users (email, password_hash, full_name, is_superadmin, email_verified_at)
		VALUES ($1, $2, $3, $4, now())
		RETURNING id, email, email_verified_at, password_hash, full_name, status,
		          failed_login_count, locked_until, is_superadmin, last_login_at, created_at, updated_at`
	return scanUser(s.pool.QueryRow(ctx, q, email, passwordHash, fullName, superadmin))
}

func (s *Store) RecordLoginSuccess(ctx context.Context, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, userID)
	return err
}

// RecordLoginFailure increments the counter and locks the account for 15 minutes
// once it crosses a threshold (brute-force mitigation, complements rate limiting).
func (s *Store) RecordLoginFailure(ctx context.Context, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users
		SET failed_login_count = failed_login_count + 1,
		    locked_until = CASE WHEN failed_login_count + 1 >= 5
		                        THEN now() + interval '15 minutes' ELSE locked_until END
		WHERE id = $1`, userID)
	return err
}

func (s *Store) SetPasswordHash(ctx context.Context, userID uuid.UUID, hash string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET password_hash = $2, password_updated_at = now() WHERE id = $1`, userID, hash)
	return err
}

func (s *Store) GetOrgByID(ctx context.Context, id uuid.UUID) (*Organization, error) {
	const q = `SELECT id, slug, name, status, billing_plan_id, created_at FROM organizations WHERE id = $1 AND deleted_at IS NULL`
	return scanOrg(s.pool.QueryRow(ctx, q, id))
}

func (s *Store) GetOrgBySlug(ctx context.Context, slug string) (*Organization, error) {
	const q = `SELECT id, slug, name, status, billing_plan_id, created_at FROM organizations WHERE slug = $1 AND deleted_at IS NULL`
	return scanOrg(s.pool.QueryRow(ctx, q, slug))
}

func scanOrg(row rowScanner) (*Organization, error) {
	var o Organization
	if err := row.Scan(&o.ID, &o.Slug, &o.Name, &o.Status, &o.BillingPlanID, &o.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &o, nil
}

// GetSystemRoleID returns the id of a system role (organization_id IS NULL).
func (s *Store) GetSystemRoleID(ctx context.Context, name string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM roles WHERE organization_id IS NULL AND name = $1`, name).Scan(&id)
	return id, norows(err)
}

// CreateMembership links a user to an org with a role (idempotent on conflict).
func (s *Store) CreateMembership(ctx context.Context, userID, orgID, roleID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO memberships (user_id, organization_id, role_id, status)
		VALUES ($1, $2, $3, 'active')
		ON CONFLICT (user_id, organization_id) DO UPDATE SET role_id = EXCLUDED.role_id`,
		userID, orgID, roleID)
	return err
}

// PrimaryMembership returns the user's first (oldest) active membership.
func (s *Store) PrimaryMembership(ctx context.Context, userID uuid.UUID) (*Membership, error) {
	var m Membership
	err := s.pool.QueryRow(ctx, `
		SELECT id, user_id, organization_id, role_id, status
		FROM memberships WHERE user_id = $1 AND status = 'active'
		ORDER BY created_at ASC LIMIT 1`, userID).
		Scan(&m.ID, &m.UserID, &m.OrganizationID, &m.RoleID, &m.Status)
	if err != nil {
		return nil, norows(err)
	}
	return &m, nil
}

// PermissionKeysForUserOrg resolves the flattened permission set for a principal
// within an organization (via their role).
func (s *Store) PermissionKeysForUserOrg(ctx context.Context, userID, orgID uuid.UUID) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.key
		FROM memberships m
		JOIN role_permissions rp ON rp.role_id = m.role_id
		JOIN permissions p ON p.id = rp.permission_id
		WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status = 'active'`,
		userID, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}
