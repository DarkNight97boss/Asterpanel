-- 0016_reseller.down.sql
BEGIN;

DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('reseller.read','reseller.manage'));
DELETE FROM permissions WHERE key IN ('reseller.read','reseller.manage');
DROP INDEX IF EXISTS idx_org_parent;
ALTER TABLE organizations DROP COLUMN IF EXISTS is_reseller;
ALTER TABLE organizations DROP COLUMN IF EXISTS parent_org_id;

COMMIT;
