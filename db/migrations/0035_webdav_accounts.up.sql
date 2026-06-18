-- 0035_webdav_accounts.up.sql — Web Disk (WebDAV) accounts served by Caddy.
BEGIN;

CREATE TABLE webdav_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain          text NOT NULL,
  path            text NOT NULL DEFAULT '/webdav/*',
  username        text NOT NULL,
  password_hash   text NOT NULL,
  root            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, domain, username)
);
CREATE INDEX idx_webdav_org ON webdav_accounts (organization_id);

COMMIT;
