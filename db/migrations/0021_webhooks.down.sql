-- 0021_webhooks.down.sql
BEGIN;

DROP TABLE IF EXISTS webhooks;
DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('webhooks.read','webhooks.manage'));
DELETE FROM permissions WHERE key IN ('webhooks.read','webhooks.manage');

COMMIT;
