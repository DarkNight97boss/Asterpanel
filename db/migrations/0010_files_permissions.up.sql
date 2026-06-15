-- 0010_files_permissions.up.sql — file manager permissions (site-scoped).
BEGIN;

INSERT INTO permissions (key, description, category) VALUES
  ('files.read',   'Browse and read site files',          'files'),
  ('files.manage', 'Write, upload and delete site files', 'files')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin')
  AND p.key IN ('files.read','files.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.key IN ('files.read','files.manage')
WHERE r.is_system AND r.name = 'developer'
ON CONFLICT DO NOTHING;

COMMIT;
