-- 0044_org_suspension_source.down.sql
BEGIN;

ALTER TABLE organizations DROP COLUMN IF EXISTS suspension_source;

COMMIT;
