-- 0021_webhooks.up.sql — customer-facing outbound webhooks.
BEGIN;

CREATE TABLE webhooks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url               text NOT NULL,
  secret            text NOT NULL,
  events            text[] NOT NULL DEFAULT '{}',
  active            boolean NOT NULL DEFAULT true,
  last_status       int,
  last_delivered_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhooks_org ON webhooks (organization_id);

INSERT INTO permissions (key, description, category) VALUES
  ('webhooks.read',   'View outbound webhooks',          'integrations'),
  ('webhooks.manage', 'Create, test and delete webhooks', 'integrations')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin','developer')
  AND p.key IN ('webhooks.read','webhooks.manage')
ON CONFLICT DO NOTHING;

COMMIT;
