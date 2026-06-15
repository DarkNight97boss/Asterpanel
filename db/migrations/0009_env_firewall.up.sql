-- 0009_env_firewall.up.sql — org-level env/secrets, firewall rules.
BEGIN;

-- Allow organization-level (app-independent) environment variables + secrets.
ALTER TABLE environment_variables ALTER COLUMN application_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_env_org_key
  ON environment_variables (organization_id, key) WHERE application_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_secret_org_key
  ON secrets (organization_id, key) WHERE application_id IS NULL;

CREATE TABLE firewall_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  server_node_id  uuid REFERENCES server_nodes(id) ON DELETE SET NULL,
  action          text NOT NULL CHECK (action IN ('allow','deny')),
  source          text NOT NULL,
  port            text NOT NULL DEFAULT '*',
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fw_org ON firewall_rules(organization_id);

INSERT INTO permissions (key, description, category) VALUES
  ('firewall.read',   'View firewall rules',   'security'),
  ('firewall.manage', 'Manage firewall rules', 'security'),
  ('billing.read',    'View billing & usage',  'billing')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin')
  AND p.key IN ('firewall.read','firewall.manage','billing.read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.key IN ('firewall.read','firewall.manage')
WHERE r.is_system AND r.name = 'developer'
ON CONFLICT DO NOTHING;

COMMIT;
