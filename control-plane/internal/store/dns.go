package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CreateDomainWithZone creates a domain, its authoritative zone, and a default
// NS record, atomically. Returns the domain and the new zone id.
func (s *Store) CreateDomainWithZone(ctx context.Context, orgID uuid.UUID, fqdn string) (*Domain, uuid.UUID, error) {
	var d Domain
	var zoneID uuid.UUID
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO domains (organization_id, fqdn, status, verification_method)
			VALUES ($1, $2, 'pending', 'dns-01')
			RETURNING id, organization_id, fqdn, status, verified_at, auto_renew, created_at`,
			orgID, fqdn).Scan(&d.ID, &d.OrganizationID, &d.FQDN, &d.Status, &d.VerifiedAt, &d.AutoRenew, &d.CreatedAt); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO dns_zones (organization_id, domain_id, name, provider)
			VALUES ($1, $2, $3, 'internal')
			RETURNING id`, orgID, d.ID, fqdn).Scan(&zoneID); err != nil {
			return err
		}
		// Default authoritative NS record.
		_, err := tx.Exec(ctx, `
			INSERT INTO dns_records (dns_zone_id, organization_id, name, type, content, ttl)
			VALUES ($1, $2, '@', 'NS', $3, 3600)`,
			zoneID, orgID, "ns1."+fqdn+".")
		return err
	})
	if err != nil {
		return nil, uuid.Nil, err
	}
	return &d, zoneID, nil
}

func (s *Store) ListDomains(ctx context.Context, orgID uuid.UUID) ([]Domain, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, organization_id, fqdn, status, verified_at, auto_renew, created_at
		FROM domains WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Domain
	for rows.Next() {
		var d Domain
		if err := rows.Scan(&d.ID, &d.OrganizationID, &d.FQDN, &d.Status, &d.VerifiedAt, &d.AutoRenew, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ZoneForDomain returns the zone id + apex name for a domain owned by the org.
func (s *Store) ZoneForDomain(ctx context.Context, orgID, domainID uuid.UUID) (uuid.UUID, string, error) {
	var id uuid.UUID
	var name string
	err := s.pool.QueryRow(ctx, `
		SELECT z.id, z.name FROM dns_zones z
		WHERE z.domain_id = $1 AND z.organization_id = $2`, domainID, orgID).Scan(&id, &name)
	return id, name, norows(err)
}

func (s *Store) ListDNSRecords(ctx context.Context, orgID uuid.UUID) ([]DNSRecord, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.id, r.dns_zone_id, z.name, r.name, r.type, r.content, r.ttl, r.priority, r.proxied, r.created_at
		FROM dns_records r JOIN dns_zones z ON z.id = r.dns_zone_id
		WHERE r.organization_id = $1 ORDER BY z.name, r.name, r.type`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DNSRecord
	for rows.Next() {
		var r DNSRecord
		if err := rows.Scan(&r.ID, &r.ZoneID, &r.ZoneName, &r.Name, &r.Type, &r.Content, &r.TTL, &r.Priority, &r.Proxied, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type CreateDNSRecordParams struct {
	OrgID    uuid.UUID
	ZoneID   uuid.UUID
	Name     string
	Type     string
	Content  string
	TTL      int
	Priority *int
}

func (s *Store) CreateDNSRecord(ctx context.Context, p CreateDNSRecordParams) (*DNSRecord, error) {
	if p.TTL <= 0 {
		p.TTL = 3600
	}
	var r DNSRecord
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO dns_records (dns_zone_id, organization_id, name, type, content, ttl, priority)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id, dns_zone_id, name, type, content, ttl, priority, proxied, created_at`,
			p.ZoneID, p.OrgID, p.Name, p.Type, p.Content, p.TTL, p.Priority).
			Scan(&r.ID, &r.ZoneID, &r.Name, &r.Type, &r.Content, &r.TTL, &r.Priority, &r.Proxied, &r.CreatedAt); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE dns_zones SET serial = serial + 1 WHERE id = $1`, p.ZoneID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// DeleteDNSRecord removes a record (org-scoped) and bumps its zone serial.
// Returns the affected zone id so the caller can re-apply the zone.
func (s *Store) DeleteDNSRecord(ctx context.Context, orgID, recordID uuid.UUID) (uuid.UUID, error) {
	var zoneID uuid.UUID
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			DELETE FROM dns_records WHERE id = $1 AND organization_id = $2
			RETURNING dns_zone_id`, recordID, orgID).Scan(&zoneID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE dns_zones SET serial = serial + 1 WHERE id = $1`, zoneID)
		return err
	})
	return zoneID, norows(err)
}

// ZoneApply bundles everything the agent needs to render a zone file.
type ZoneApply struct {
	Name    string
	Serial  int64
	Records []DNSRecord
}

func (s *Store) ZoneForApply(ctx context.Context, zoneID uuid.UUID) (*ZoneApply, error) {
	var z ZoneApply
	if err := s.pool.QueryRow(ctx, `SELECT name, serial FROM dns_zones WHERE id = $1`, zoneID).
		Scan(&z.Name, &z.Serial); err != nil {
		return nil, norows(err)
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, dns_zone_id, name, type, content, ttl, priority, proxied, created_at
		FROM dns_records WHERE dns_zone_id = $1 ORDER BY type, name`, zoneID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r DNSRecord
		if err := rows.Scan(&r.ID, &r.ZoneID, &r.Name, &r.Type, &r.Content, &r.TTL, &r.Priority, &r.Proxied, &r.CreatedAt); err != nil {
			return nil, err
		}
		z.Records = append(z.Records, r)
	}
	return &z, rows.Err()
}
