-- 0036_caldav_accounts.up.sql — CalDAV/CardDAV accounts (Radicale htpasswd).
BEGIN;

CREATE TABLE caldav_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  username        text NOT NULL,
  password_hash   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, username)
);
CREATE INDEX idx_caldav_org ON caldav_accounts (organization_id);

COMMIT;
