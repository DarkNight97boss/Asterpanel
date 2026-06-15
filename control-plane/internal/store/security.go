package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// IPCount is a source IP and its failed-auth count in the watch window.
type IPCount struct {
	IP    string
	Count int
}

// RecentFailedAuthIPs groups failed login/MFA attempts by source IP since the
// given time and returns those at or above the threshold — the input to the
// brute-force auto-ban watch.
func (s *Store) RecentFailedAuthIPs(ctx context.Context, since time.Time, threshold int) ([]IPCount, error) {
	const q = `
		SELECT host(ip) AS ip, count(*) AS n
		FROM audit_logs
		WHERE action IN ('auth.login', 'auth.mfa')
		  AND outcome IN ('failure', 'denied')
		  AND ip IS NOT NULL
		  AND created_at > $1
		GROUP BY ip
		HAVING count(*) >= $2
		ORDER BY n DESC`
	rows, err := s.pool.Query(ctx, q, since, threshold)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IPCount
	for rows.Next() {
		var c IPCount
		if err := rows.Scan(&c.IP, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// OrgIDsWithNodes returns the orgs that have at least one node — the orgs whose
// firewalls the brute-force watch enforces auto-bans on.
func (s *Store) OrgIDsWithNodes(ctx context.Context) ([]uuid.UUID, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT organization_id FROM server_nodes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
