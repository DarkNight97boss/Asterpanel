-- 0007_commercial.up.sql — SSL certificates and email mailboxes (commercial features).
BEGIN;

CREATE TABLE ssl_certificates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain_id       uuid REFERENCES domains(id) ON DELETE SET NULL,
  domain          citext NOT NULL,
  issuer          text NOT NULL DEFAULT 'letsencrypt',
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','issuing','active','error','expired')),
  cert_secret_id  uuid REFERENCES secrets(id) ON DELETE SET NULL,
  auto_renew      boolean NOT NULL DEFAULT true,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ssl_org ON ssl_certificates(organization_id);
CREATE TRIGGER trg_ssl_updated BEFORE UPDATE ON ssl_certificates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE mailboxes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain_id             uuid REFERENCES domains(id) ON DELETE SET NULL,
  server_node_id        uuid REFERENCES server_nodes(id) ON DELETE SET NULL,
  address               citext NOT NULL UNIQUE,
  quota_mb              int NOT NULL DEFAULT 1024,
  used_mb               int NOT NULL DEFAULT 0,
  credentials_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','suspended','deleting')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mailboxes_org ON mailboxes(organization_id);
CREATE TRIGGER trg_mailboxes_updated BEFORE UPDATE ON mailboxes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- New permissions for the commercial features.
INSERT INTO permissions (key, description, category) VALUES
  ('ssl.read',     'View SSL certificates',  'ssl'),
  ('ssl.manage',   'Issue/renew certificates','ssl'),
  ('email.read',   'View mailboxes',         'email'),
  ('email.manage', 'Manage mailboxes',       'email')
ON CONFLICT (key) DO NOTHING;

-- Grant the new permissions to the system owner/admin/developer roles.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin')
  AND p.key IN ('ssl.read','ssl.manage','email.read','email.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.key IN ('ssl.read','ssl.manage','email.read','email.manage')
WHERE r.is_system AND r.name = 'developer'
ON CONFLICT DO NOTHING;

COMMIT;
