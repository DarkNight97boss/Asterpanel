package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Store) CreateNode(ctx context.Context, orgID uuid.UUID, name, hostname string, region *string) (*ServerNode, error) {
	const q = `
		INSERT INTO server_nodes (organization_id, name, hostname, region)
		VALUES ($1, $2, $3, $4)
		RETURNING id, organization_id, name, hostname, region, ip_address::text, agent_version,
		          status, labels, capabilities, cert_fingerprint, last_heartbeat_at, enrolled_at, created_at`
	return scanNode(s.pool.QueryRow(ctx, q, orgID, name, hostname, region))
}

func (s *Store) GetNode(ctx context.Context, orgID, id uuid.UUID) (*ServerNode, error) {
	const q = `
		SELECT id, organization_id, name, hostname, region, ip_address::text, agent_version,
		       status, labels, capabilities, cert_fingerprint, last_heartbeat_at, enrolled_at, created_at
		FROM server_nodes WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`
	return scanNode(s.pool.QueryRow(ctx, q, id, orgID))
}

func (s *Store) ListNodes(ctx context.Context, orgID uuid.UUID) ([]ServerNode, error) {
	const q = `
		SELECT id, organization_id, name, hostname, region, ip_address::text, agent_version,
		       status, labels, capabilities, cert_fingerprint, last_heartbeat_at, enrolled_at, created_at
		FROM server_nodes WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ServerNode
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *n)
	}
	return out, rows.Err()
}

func scanNode(row rowScanner) (*ServerNode, error) {
	var n ServerNode
	var labels, caps []byte
	err := row.Scan(&n.ID, &n.OrganizationID, &n.Name, &n.Hostname, &n.Region, &n.IPAddress, &n.AgentVersion,
		&n.Status, &labels, &caps, &n.CertFingerprint, &n.LastHeartbeatAt, &n.EnrolledAt, &n.CreatedAt)
	if err != nil {
		return nil, norows(err)
	}
	n.Labels = labels
	n.Capabilities = caps
	return &n, nil
}

func (s *Store) UpdateNodeStatus(ctx context.Context, orgID, id uuid.UUID, status string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE server_nodes SET status = $3 WHERE id = $1 AND organization_id = $2`, id, orgID, status)
	return err
}

// Heartbeat marks the node online and records the latest contact time.
func (s *Store) Heartbeat(ctx context.Context, id uuid.UUID, agentVersion string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE server_nodes
		SET last_heartbeat_at = now(), status = 'online', agent_version = COALESCE(NULLIF($2,''), agent_version)
		WHERE id = $1`, id, agentVersion)
	return err
}

// --- Agent enrollment ---------------------------------------------------------

func (s *Store) CreateAgentRegistration(ctx context.Context, nodeID, orgID uuid.UUID, tokenHash []byte, createdBy uuid.NullUUID, expiresAt time.Time) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `
		INSERT INTO agent_registrations (server_node_id, organization_id, enrollment_token_hash, created_by, expires_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`,
		nodeID, orgID, tokenHash, createdBy, expiresAt).Scan(&id)
	return id, err
}

type EnrollmentLookup struct {
	ID           uuid.UUID
	ServerNodeID uuid.UUID
	OrgID        uuid.UUID
	Status       string
	Expired      bool
}

func (s *Store) GetEnrollmentByTokenHash(ctx context.Context, tokenHash []byte) (*EnrollmentLookup, error) {
	var e EnrollmentLookup
	err := s.pool.QueryRow(ctx, `
		SELECT id, server_node_id, organization_id, status, (expires_at < now())
		FROM agent_registrations WHERE enrollment_token_hash = $1`, tokenHash).
		Scan(&e.ID, &e.ServerNodeID, &e.OrgID, &e.Status, &e.Expired)
	if err != nil {
		return nil, norows(err)
	}
	return &e, nil
}

// CompleteEnrollment burns the bootstrap token, records the issued cert and
// marks the node enrolled — all in one transaction.
func (s *Store) CompleteEnrollment(ctx context.Context, regID, nodeID uuid.UUID, certPEM, certSerial, fingerprint string) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE agent_registrations
			SET status = 'used', used_at = now(), cert_pem = $2, cert_serial = $3, cert_fingerprint = $4
			WHERE id = $1`, regID, certPEM, certSerial, fingerprint); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE server_nodes
			SET status = 'online', enrolled_at = now(), cert_fingerprint = $2
			WHERE id = $1`, nodeID, fingerprint)
		return err
	})
}

func (s *Store) InsertNodeMetrics(ctx context.Context, nodeID uuid.UUID, cpu float64, memUsed, memTotal, diskUsed, diskTotal int64, load1 float64, containers int) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO node_metrics (server_node_id, cpu_pct, mem_used_bytes, mem_total_bytes,
		                          disk_used_bytes, disk_total_bytes, load1, containers_running)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		nodeID, cpu, memUsed, memTotal, diskUsed, diskTotal, load1, containers)
	return err
}
