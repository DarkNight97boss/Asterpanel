-- 0032_ddns.up.sql — dynamic DNS hosts (token-updatable A records).
BEGIN;

CREATE TABLE ddns_hosts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain_id       uuid NOT NULL,
  name            text NOT NULL,
  token           text NOT NULL UNIQUE,
  last_ip         text,
  updated_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, domain_id, name)
);
CREATE INDEX idx_ddns_org ON ddns_hosts (organization_id);

COMMIT;
