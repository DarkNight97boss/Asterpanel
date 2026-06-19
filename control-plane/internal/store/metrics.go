package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// MetricPoint is one time bucket of the org's resource usage (percentages).
type MetricPoint struct {
	Time    time.Time
	CPUPct  float64
	MemPct  float64
	DiskPct float64
}

// MetricsHistory buckets the org's node_metrics time series since `since` into
// `bucketSec`-wide buckets, averaging CPU / memory / disk utilisation (percent)
// across the org's nodes — the data behind the per-account history chart.
func (s *Store) MetricsHistory(ctx context.Context, orgID uuid.UUID, since time.Time, bucketSec int) ([]MetricPoint, error) {
	const q = `
		SELECT to_timestamp(floor(extract(epoch FROM nm.collected_at) / $3) * $3) AS bucket,
		       AVG(nm.cpu_pct),
		       AVG(nm.mem_used_bytes::float8  / NULLIF(nm.mem_total_bytes, 0)  * 100),
		       AVG(nm.disk_used_bytes::float8 / NULLIF(nm.disk_total_bytes, 0) * 100)
		FROM node_metrics nm
		JOIN server_nodes sn ON sn.id = nm.server_node_id
		WHERE sn.organization_id = $1 AND nm.collected_at >= $2
		GROUP BY 1
		ORDER BY 1 ASC`
	rows, err := s.pool.Query(ctx, q, orgID, since, bucketSec)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MetricPoint
	for rows.Next() {
		var p MetricPoint
		var mem, disk *float64
		if err := rows.Scan(&p.Time, &p.CPUPct, &mem, &disk); err != nil {
			return nil, err
		}
		if mem != nil {
			p.MemPct = *mem
		}
		if disk != nil {
			p.DiskPct = *disk
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

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
