-- 0011_website_runtime_version.down.sql
BEGIN;

ALTER TABLE websites DROP COLUMN IF EXISTS runtime_version;

COMMIT;
