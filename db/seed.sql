-- seed.sql — idempotent reference data: permissions, system roles, plans, demo org.
-- The admin USER is created via `controlplane create-admin` (proper Argon2id hashing),
-- not here, so no password hash is ever committed to SQL.
BEGIN;

-- ── Permissions ─────────────────────────────────────────────────────────────
INSERT INTO permissions (key, description, category) VALUES
  ('org.read',            'View organization',                 'org'),
  ('org.update',          'Update organization settings',      'org'),
  ('org.manage_members',  'Invite/remove members',             'org'),
  ('org.manage_billing',  'Manage billing & plan',             'org'),
  ('sso.read',            'View SSO (OIDC) providers',         'org'),
  ('sso.manage',          'Configure SSO (OIDC) providers',    'org'),
  ('role.read',           'View roles',                        'rbac'),
  ('role.manage',         'Create/update roles',               'rbac'),
  ('apitoken.read',       'List API tokens',                   'apitoken'),
  ('apitoken.create',     'Create API tokens',                 'apitoken'),
  ('apitoken.revoke',     'Revoke API tokens',                 'apitoken'),
  ('node.read',           'View server nodes',                 'node'),
  ('node.create',         'Register server nodes',             'node'),
  ('node.update',         'Update server nodes',               'node'),
  ('node.delete',         'Decommission server nodes',         'node'),
  ('node.enroll',         'Issue agent enrollment tokens',     'node'),
  ('metrics.read',        'View node/app metrics',             'metrics'),
  ('domain.read',         'View domains',                      'domain'),
  ('domain.create',       'Add domains',                       'domain'),
  ('domain.update',       'Update domains',                    'domain'),
  ('domain.delete',       'Remove domains',                    'domain'),
  ('dns.read',            'View DNS records',                  'dns'),
  ('dns.manage',          'Manage DNS records',                'dns'),
  ('website.read',        'View websites',                     'website'),
  ('website.create',      'Create websites',                   'website'),
  ('website.update',      'Update websites',                   'website'),
  ('website.delete',      'Delete websites',                   'website'),
  ('app.read',            'View applications',                 'app'),
  ('app.create',          'Create applications',               'app'),
  ('app.update',          'Update applications',               'app'),
  ('app.delete',          'Delete applications',               'app'),
  ('deploy.read',         'View deployments & logs',           'deploy'),
  ('deploy.create',       'Trigger deployments',               'deploy'),
  ('deploy.rollback',     'Roll back deployments',             'deploy'),
  ('env.read',            'View environment variables',        'env'),
  ('env.manage',          'Manage environment variables',      'env'),
  ('secret.read',         'List secret keys (never values)',   'secret'),
  ('secret.manage',       'Create/update/delete secrets',      'secret'),
  ('database.read',       'View database instances',           'database'),
  ('database.create',     'Provision databases',               'database'),
  ('database.delete',     'Delete databases',                  'database'),
  ('database.query',      'Run ad-hoc SQL queries',            'database'),
  ('service.read',        'View node services/containers',     'node'),
  ('service.manage',      'Restart node services/containers',  'node'),
  ('backup.read',         'View backups',                      'backup'),
  ('backup.create',       'Create backups',                    'backup'),
  ('backup.restore',      'Restore backups',                   'backup'),
  ('audit.read',          'View audit log',                    'audit'),
  ('notification.read',   'View notifications',                'notification')
ON CONFLICT (key) DO NOTHING;

-- ── System roles (organization_id IS NULL) ──────────────────────────────────
INSERT INTO roles (name, description, is_system) VALUES
  ('owner',     'Full control of the organization',                 true),
  ('admin',     'Administer everything except billing',             true),
  ('developer', 'Manage sites, apps, deploys, DNS, secrets',        true),
  ('viewer',    'Read-only access',                                 true),
  ('billing',   'Billing management and read access',               true)
ON CONFLICT DO NOTHING;

-- owner → every permission
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name = 'owner'
ON CONFLICT DO NOTHING;

-- admin → everything except billing management
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name = 'admin' AND p.key <> 'org.manage_billing'
ON CONFLICT DO NOTHING;

-- developer → curated build/deploy permission set
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN (
  'org.read','metrics.read','notification.read',
  'domain.read','domain.create','domain.update',
  'dns.read','dns.manage',
  'website.read','website.create','website.update','website.delete',
  'app.read','app.create','app.update','app.delete',
  'deploy.read','deploy.create','deploy.rollback',
  'env.read','env.manage','secret.read','secret.manage',
  'database.read','database.create','database.delete','database.query',
  'service.read','service.manage',
  'backup.read','backup.create','backup.restore'
)
WHERE r.is_system AND r.name = 'developer'
ON CONFLICT DO NOTHING;

-- viewer → all read-only permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON (p.key LIKE '%.read')
WHERE r.is_system AND r.name = 'viewer'
ON CONFLICT DO NOTHING;

-- billing → org read + billing management + metrics
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN (
  'org.read','org.manage_billing','metrics.read','notification.read'
)
WHERE r.is_system AND r.name = 'billing'
ON CONFLICT DO NOTHING;

-- ── Billing plans ───────────────────────────────────────────────────────────
INSERT INTO billing_plans (code, name, description, price_cents, currency, interval, limits) VALUES
  ('free',  'Free',       'For evaluation',     0,    'EUR', 'month',
     '{"max_sites":1,"max_apps":1,"max_nodes":1,"max_domains":1}'),
  ('pro',   'Pro',        'For small teams',    2900, 'EUR', 'month',
     '{"max_sites":25,"max_apps":50,"max_nodes":5,"max_domains":50}'),
  ('scale', 'Scale',      'For growing fleets', 9900, 'EUR', 'month',
     '{"max_sites":250,"max_apps":500,"max_nodes":50,"max_domains":500}')
ON CONFLICT (code) DO NOTHING;

-- ── Demo organization (dev only) ────────────────────────────────────────────
INSERT INTO organizations (slug, name, status, billing_plan_id)
SELECT 'acme', 'Acme Inc', 'active', bp.id FROM billing_plans bp WHERE bp.code = 'pro'
ON CONFLICT (slug) DO NOTHING;

COMMIT;
