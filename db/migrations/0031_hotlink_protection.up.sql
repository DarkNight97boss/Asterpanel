-- 0031_hotlink_protection.up.sql — per-domain hotlink protection (Caddy referer).
BEGIN;

CREATE TABLE hotlink_protection (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain           text NOT NULL,
  allowed_referers text[] NOT NULL DEFAULT '{}',
  extensions       text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, domain)
);
CREATE INDEX idx_hotlink_org ON hotlink_protection (organization_id);

COMMIT;
