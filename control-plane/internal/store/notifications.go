package store

import (
	"context"

	"github.com/google/uuid"
)

type CreateNotificationParams struct {
	OrgID        uuid.UUID
	UserID       uuid.UUID
	Type         string
	Severity     string // info | success | warning | error
	Title        string
	Body         string
	ResourceType string
	ResourceID   string
}

// CreateNotification inserts an in-app notification for a user.
func (s *Store) CreateNotification(ctx context.Context, p CreateNotificationParams) error {
	severity := p.Severity
	if severity == "" {
		severity = "info"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO notifications (organization_id, user_id, type, severity, title, body, resource_type, resource_id)
		VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7,''), NULLIF($8,''))`,
		p.OrgID, p.UserID, p.Type, severity, p.Title, p.Body, p.ResourceType, p.ResourceID)
	return err
}
