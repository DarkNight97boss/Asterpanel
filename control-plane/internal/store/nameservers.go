package store

import "context"

type Nameserver struct {
	Hostname string
	IPv4     *string
	Label    *string
}

// ListNameservers returns the fleet's authoritative nameservers (the NS records
// customers point their domains at).
func (s *Store) ListNameservers(ctx context.Context) ([]Nameserver, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT hostname, host(ipv4), label FROM dns_nameservers ORDER BY sort, hostname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Nameserver
	for rows.Next() {
		var n Nameserver
		if err := rows.Scan(&n.Hostname, &n.IPv4, &n.Label); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
