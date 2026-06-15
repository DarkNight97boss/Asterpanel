-- 0010_files_permissions.down.sql
BEGIN;

DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('files.read','files.manage'));
DELETE FROM permissions WHERE key IN ('files.read','files.manage');

COMMIT;
