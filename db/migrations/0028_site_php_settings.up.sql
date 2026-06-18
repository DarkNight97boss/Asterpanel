-- 0028_site_php_settings.up.sql — per-site php.ini overrides (MultiPHP INI).
BEGIN;

CREATE TABLE site_php_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id      uuid NOT NULL,
  directive       text NOT NULL,
  value           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (website_id, directive)
);
CREATE INDEX idx_site_php_org ON site_php_settings (organization_id);
CREATE INDEX idx_site_php_site ON site_php_settings (website_id);

COMMIT;
