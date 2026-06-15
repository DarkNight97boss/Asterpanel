package store

import (
	"context"

	"github.com/google/uuid"
)

// (InsertNodeMetrics lives in nodes.go and writes the byte-denominated
// node_metrics time series created in migration 0002.)

// FleetMetrics is the latest snapshot aggregated across an org's nodes, plus a
// short CPU history for the panel sparkline. Memory is reported in MB and disk
// in GB to match the panel contract; storage is in bytes.
type FleetMetrics struct {
	CPUPct      float64
	MemUsedMB   int64
	MemTotalMB  int64
	DiskUsedGB  int64
	DiskTotalGB int64
	CPUSeries   []float64
}

// FleetMetrics aggregates the most-recent sample per node (avg CPU, summed
// memory/disk) and an org-wide average CPU series over the last buckets.
func (s *Store) FleetMetrics(ctx context.Context, orgID uuid.UUID) (*FleetMetrics, error) {
	const aggQ = `
		WITH latest AS (
			SELECT DISTINCT ON (nm.server_node_id) nm.*
			FROM node_metrics nm
			JOIN server_nodes sn ON sn.id = nm.server_node_id
			WHERE sn.organization_id = $1
			ORDER BY nm.server_node_id, nm.collected_at DESC
		)
		SELECT COALESCE(AVG(cpu_pct), 0),
		       COALESCE(SUM(mem_used_bytes), 0)  / 1048576,
		       COALESCE(SUM(mem_total_bytes), 0) / 1048576,
		       COALESCE(SUM(disk_used_bytes), 0)  / 1073741824,
		       COALESCE(SUM(disk_total_bytes), 0) / 1073741824
		FROM latest`
	var fm FleetMetrics
	if err := s.pool.QueryRow(ctx, aggQ, orgID).Scan(
		&fm.CPUPct, &fm.MemUsedMB, &fm.MemTotalMB, &fm.DiskUsedGB, &fm.DiskTotalGB); err != nil {
		return nil, err
	}

	const seriesQ = `
		SELECT cpu FROM (
			SELECT collected_at, AVG(cpu_pct) AS cpu
			FROM node_metrics nm
			JOIN server_nodes sn ON sn.id = nm.server_node_id
			WHERE sn.organization_id = $1
			GROUP BY collected_at
			ORDER BY collected_at DESC
			LIMIT 24
		) t ORDER BY t.collected_at ASC`
	rows, err := s.pool.Query(ctx, seriesQ, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v float64
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		fm.CPUSeries = append(fm.CPUSeries, v)
	}
	return &fm, rows.Err()
}
