-- 0026_redirects.up.sql — URL redirects rendered into the Caddy config.
BEGIN;

CREATE TABLE redirects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_domain   text NOT NULL,
  source_path     text NOT NULL DEFAULT '*',
  target_url      text NOT NULL,
  status_code     int  NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302, 307, 308)),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_redirects_org ON redirects (organization_id);

COMMIT;
