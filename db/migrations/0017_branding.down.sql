-- 0017_branding.down.sql
BEGIN;

DROP TABLE IF EXISTS org_branding;
DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('branding.read','branding.manage'));
DELETE FROM permissions WHERE key IN ('branding.read','branding.manage');

COMMIT;
