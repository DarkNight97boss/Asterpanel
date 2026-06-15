-- 0011_website_runtime_version.up.sql — per-site language version (PHP/Node…).
BEGIN;

ALTER TABLE websites ADD COLUMN IF NOT EXISTS runtime_version text;

COMMIT;
