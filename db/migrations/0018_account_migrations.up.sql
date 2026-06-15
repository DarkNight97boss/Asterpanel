-- 0018_account_migrations.up.sql — imports from cPanel/Plesk.
BEGIN;

CREATE TABLE account_migrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type     text NOT NULL DEFAULT 'cpanel' CHECK (source_type IN ('cpanel','plesk')),
  source_label    text,
  status          text NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned','importing','completed','failed')),
  domains_count   int NOT NULL DEFAULT 0,
  databases_count int NOT NULL DEFAULT 0,
  mailboxes_count int NOT NULL DEFAULT 0,
  plan            jsonb NOT NULL DEFAULT '{}',
  log             jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX idx_account_migrations_org ON account_migrations (organization_id, created_at DESC);

INSERT INTO permissions (key, description, category) VALUES
  ('migration.read',   'View account migrations',          'migration'),
  ('migration.manage', 'Plan and run account migrations',  'migration')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin')
  AND p.key IN ('migration.read','migration.manage')
ON CONFLICT DO NOTHING;

COMMIT;
