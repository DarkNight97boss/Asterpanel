-- 0012_metrics_permission.up.sql — grant the metrics.read permission.
-- (The node_metrics time-series table already exists from 0002.)
BEGIN;

INSERT INTO permissions (key, description, category) VALUES
  ('metrics.read', 'View node & fleet metrics', 'observability')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin','developer')
  AND p.key = 'metrics.read'
ON CONFLICT DO NOTHING;

COMMIT;
