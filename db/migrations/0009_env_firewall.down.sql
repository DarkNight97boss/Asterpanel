BEGIN;
DROP TABLE IF EXISTS firewall_rules;
DROP INDEX IF EXISTS uq_env_org_key;
DROP INDEX IF EXISTS uq_secret_org_key;
DELETE FROM permissions WHERE key IN ('firewall.read','firewall.manage','billing.read');
-- Note: environment_variables.application_id is left nullable (re-adding NOT NULL
-- could fail if org-level rows exist).
COMMIT;
