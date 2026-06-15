-- 0017_branding.up.sql — per-organization white-label branding.
BEGIN;

CREATE TABLE org_branding (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  panel_name      text,
  logo_url        text,
  primary_color   text,
  support_email   text,
  support_url     text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO permissions (key, description, category) VALUES
  ('branding.read',   'View white-label branding',   'branding'),
  ('branding.manage', 'Manage white-label branding', 'branding')
ON CONFLICT (key) DO NOTHING;

-- Everyone who uses the panel can read its branding; only owner/admin manage it.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin','developer','member','viewer')
  AND p.key = 'branding.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin')
  AND p.key = 'branding.manage'
ON CONFLICT DO NOTHING;

COMMIT;
