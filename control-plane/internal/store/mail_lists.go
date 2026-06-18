package store

import (
	"context"

	"github.com/google/uuid"
)

func (s *Store) CreateMailList(ctx context.Context, orgID uuid.UUID, address string) (*MailList, error) {
	const q = `
		INSERT INTO mail_lists (organization_id, address) VALUES ($1, $2)
		RETURNING id, organization_id, address, created_at`
	var l MailList
	if err := s.pool.QueryRow(ctx, q, orgID, address).Scan(&l.ID, &l.OrganizationID, &l.Address, &l.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &l, nil
}

func (s *Store) ListMailLists(ctx context.Context, orgID uuid.UUID) ([]MailList, error) {
	const q = `SELECT id, organization_id, address, created_at FROM mail_lists WHERE organization_id = $1 ORDER BY address`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MailList
	for rows.Next() {
		var l MailList
		if err := rows.Scan(&l.ID, &l.OrganizationID, &l.Address, &l.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) DeleteMailList(ctx context.Context, orgID, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM mail_lists WHERE id = $1 AND organization_id = $2`, id, orgID)
	return err
}

// AddListMember inserts a member, verifying the list belongs to the org.
func (s *Store) AddListMember(ctx context.Context, orgID, listID uuid.UUID, email string) (*MailListMember, error) {
	const q = `
		INSERT INTO mail_list_members (list_id, email)
		SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM mail_lists WHERE id = $1 AND organization_id = $3)
		RETURNING id, list_id, email, created_at`
	var m MailListMember
	if err := s.pool.QueryRow(ctx, q, listID, email, orgID).Scan(&m.ID, &m.ListID, &m.Email, &m.CreatedAt); err != nil {
		return nil, norows(err)
	}
	return &m, nil
}

func (s *Store) ListMembers(ctx context.Context, listID uuid.UUID) ([]MailListMember, error) {
	const q = `SELECT id, list_id, email, created_at FROM mail_list_members WHERE list_id = $1 ORDER BY email`
	rows, err := s.pool.Query(ctx, q, listID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MailListMember
	for rows.Next() {
		var m MailListMember
		if err := rows.Scan(&m.ID, &m.ListID, &m.Email, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) DeleteListMember(ctx context.Context, orgID, memberID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM mail_list_members m USING mail_lists l
		WHERE m.id = $1 AND m.list_id = l.id AND l.organization_id = $2`, memberID, orgID)
	return err
}

// ListsForApply returns each list address with its member emails, for rendering
// into the virtual-alias map.
func (s *Store) ListsForApply(ctx context.Context, orgID uuid.UUID) ([]MailListForApply, error) {
	const q = `
		SELECT l.address, coalesce(array_agg(m.email) FILTER (WHERE m.email IS NOT NULL), '{}')
		FROM mail_lists l LEFT JOIN mail_list_members m ON m.list_id = l.id
		WHERE l.organization_id = $1
		GROUP BY l.id, l.address ORDER BY l.address`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MailListForApply
	for rows.Next() {
		var a MailListForApply
		if err := rows.Scan(&a.Address, &a.Members); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
