-- 0027_directory_privacy.up.sql — HTTP basic-auth protected paths (Caddy).
BEGIN;

CREATE TABLE directory_privacy (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain          text NOT NULL,
  path            text NOT NULL DEFAULT '/*',
  username        text NOT NULL,
  password_hash   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dirpriv_org ON directory_privacy (organization_id);

COMMIT;
