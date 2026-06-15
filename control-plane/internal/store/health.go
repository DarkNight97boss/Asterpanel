package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// UpsertSiteHealth records the latest health snapshot for a site.
func (s *Store) UpsertSiteHealth(ctx context.Context, websiteID uuid.UUID, status string, httpCode, latencyMS *int, consecutiveFailures int) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO site_health (website_id, status, http_code, latency_ms, consecutive_failures, checked_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (website_id) DO UPDATE
		SET status = $2, http_code = $3, latency_ms = $4, consecutive_failures = $5, checked_at = now()`,
		websiteID, status, httpCode, latencyMS, consecutiveFailures)
	return err
}

// PrevSiteHealth returns the stored status + consecutive failures for transition
// detection. ("unknown", 0, nil) when no prior check exists.
func (s *Store) PrevSiteHealth(ctx context.Context, websiteID uuid.UUID) (string, int, error) {
	var status string
	var cf int
	err := s.pool.QueryRow(ctx,
		`SELECT status, consecutive_failures FROM site_health WHERE website_id = $1`, websiteID).
		Scan(&status, &cf)
	if errors.Is(err, pgx.ErrNoRows) {
		return "unknown", 0, nil
	}
	return status, cf, err
}

// AnyOrgUserID returns an active member of the org to address system-generated
// notifications to (oldest membership). Used by the background health sweep.
func (s *Store) AnyOrgUserID(ctx context.Context, orgID uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		SELECT user_id FROM memberships
		WHERE organization_id = $1 AND status = 'active'
		ORDER BY created_at ASC LIMIT 1`, orgID).Scan(&id)
	return id, err
}

type SiteHealthRow struct {
	WebsiteID           uuid.UUID
	Name                string
	Status              string
	HTTPCode            *int
	LatencyMS           *int
	ConsecutiveFailures int
	CheckedAt           *time.Time
}

// SiteForHealth is the minimal site info the background sweep needs.
type SiteForHealth struct {
	ID     uuid.UUID
	OrgID  uuid.UUID
	NodeID uuid.UUID
	Name   string
}

// ListAllSitesForHealth returns every node-assigned, non-deleted site across all
// orgs (the background health sweep iterates these).
func (s *Store) ListAllSitesForHealth(ctx context.Context) ([]SiteForHealth, error) {
	const q = `
		SELECT id, organization_id, server_node_id, name
		FROM websites
		WHERE server_node_id IS NOT NULL AND deleted_at IS NULL`
	rows, err := s.pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SiteForHealth
	for rows.Next() {
		var r SiteForHealth
		if err := rows.Scan(&r.ID, &r.OrgID, &r.NodeID, &r.Name); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// OpenIncidentIfNone opens a health incident for a site unless one is already
// open (enforced by uq_incident_open). Returns true if a new incident was
// opened (i.e. this is a fresh outage).
func (s *Store) OpenIncidentIfNone(ctx context.Context, websiteID, orgID uuid.UUID, httpCode *int) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO health_incidents (website_id, organization_id, http_code)
		VALUES ($1, $2, $3)
		ON CONFLICT (website_id) WHERE closed_at IS NULL DO NOTHING`,
		websiteID, orgID, httpCode)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// CloseOpenIncident closes the site's open incident, if any. Returns true if one
// was closed (i.e. the site just recovered).
func (s *Store) CloseOpenIncident(ctx context.Context, websiteID uuid.UUID) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE health_incidents SET closed_at = now() WHERE website_id = $1 AND closed_at IS NULL`,
		websiteID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

type Incident struct {
	ID        int64
	WebsiteID uuid.UUID
	Site      string
	OpenedAt  time.Time
	ClosedAt  *time.Time
	HTTPCode  *int
}

// ListIncidents returns the most recent incidents for an org (open first).
func (s *Store) ListIncidents(ctx context.Context, orgID uuid.UUID, limit int) ([]Incident, error) {
	const q = `
		SELECT i.id, i.website_id, w.name, i.opened_at, i.closed_at, i.http_code
		FROM health_incidents i
		JOIN websites w ON w.id = i.website_id
		WHERE i.organization_id = $1
		ORDER BY (i.closed_at IS NULL) DESC, i.opened_at DESC
		LIMIT $2`
	rows, err := s.pool.Query(ctx, q, orgID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Incident
	for rows.Next() {
		var i Incident
		if err := rows.Scan(&i.ID, &i.WebsiteID, &i.Site, &i.OpenedAt, &i.ClosedAt, &i.HTTPCode); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// ListSiteHealth returns every site in the org with its latest health (or
// 'unknown' when never probed).
func (s *Store) ListSiteHealth(ctx context.Context, orgID uuid.UUID) ([]SiteHealthRow, error) {
	const q = `
		SELECT w.id, w.name, COALESCE(h.status, 'unknown'), h.http_code, h.latency_ms,
		       COALESCE(h.consecutive_failures, 0), h.checked_at
		FROM websites w
		LEFT JOIN site_health h ON h.website_id = w.id
		WHERE w.organization_id = $1 AND w.deleted_at IS NULL
		ORDER BY w.created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SiteHealthRow
	for rows.Next() {
		var r SiteHealthRow
		if err := rows.Scan(&r.WebsiteID, &r.Name, &r.Status, &r.HTTPCode, &r.LatencyMS,
			&r.ConsecutiveFailures, &r.CheckedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
