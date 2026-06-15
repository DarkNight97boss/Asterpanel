-- 0016_reseller.up.sql — organization hierarchy (resellers → sub-accounts).
BEGIN;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_reseller boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_org_parent ON organizations (parent_org_id);

INSERT INTO permissions (key, description, category) VALUES
  ('reseller.read',   'View reseller sub-accounts',       'reseller'),
  ('reseller.manage', 'Create and manage sub-accounts',   'reseller')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin')
  AND p.key IN ('reseller.read','reseller.manage')
ON CONFLICT DO NOTHING;

COMMIT;
