-- 0012_metrics_permission.down.sql
BEGIN;

DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key = 'metrics.read');
DELETE FROM permissions WHERE key = 'metrics.read';

COMMIT;
