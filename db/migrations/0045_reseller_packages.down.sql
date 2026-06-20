-- 0045_reseller_packages.down.sql
BEGIN;

DROP INDEX IF EXISTS idx_billing_plans_owner;
ALTER TABLE billing_plans DROP COLUMN IF EXISTS owner_org_id;

COMMIT;
