-- 0018_account_migrations.down.sql
BEGIN;

DROP TABLE IF EXISTS account_migrations;
DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('migration.read','migration.manage'));
DELETE FROM permissions WHERE key IN ('migration.read','migration.manage');

COMMIT;
