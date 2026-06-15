-- 0008_cron_ftp.up.sql — cron jobs and FTP/SFTP accounts.
BEGIN;

CREATE TABLE cron_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id  uuid REFERENCES applications(id) ON DELETE CASCADE,
  server_node_id  uuid REFERENCES server_nodes(id) ON DELETE SET NULL,
  schedule        text NOT NULL,
  command         text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  last_run_at     timestamptz,
  last_status     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cron_org ON cron_jobs(organization_id);
CREATE TRIGGER trg_cron_updated BEFORE UPDATE ON cron_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ftp_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  server_node_id        uuid REFERENCES server_nodes(id) ON DELETE SET NULL,
  website_id            uuid REFERENCES websites(id) ON DELETE SET NULL,
  username              text NOT NULL,
  protocol              text NOT NULL DEFAULT 'SFTP' CHECK (protocol IN ('SFTP','FTPS')),
  home_directory        text NOT NULL,
  credentials_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleting')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, username)
);
CREATE INDEX idx_ftp_org ON ftp_accounts(organization_id);
CREATE TRIGGER trg_ftp_updated BEFORE UPDATE ON ftp_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO permissions (key, description, category) VALUES
  ('cron.read',   'View cron jobs',     'cron'),
  ('cron.manage', 'Manage cron jobs',   'cron'),
  ('ftp.read',    'View FTP accounts',  'ftp'),
  ('ftp.manage',  'Manage FTP accounts','ftp')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.is_system AND r.name IN ('owner','admin')
  AND p.key IN ('cron.read','cron.manage','ftp.read','ftp.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.key IN ('cron.read','cron.manage','ftp.read','ftp.manage')
WHERE r.is_system AND r.name = 'developer'
ON CONFLICT DO NOTHING;

COMMIT;
