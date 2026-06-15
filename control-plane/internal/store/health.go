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

type SiteHealthRow struct {
	WebsiteID           uuid.UUID
	Name                string
	Status              string
	HTTPCode            *int
	LatencyMS           *int
	ConsecutiveFailures int
	CheckedAt           *time.Time
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
