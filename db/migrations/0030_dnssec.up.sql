-- 0030_dnssec.up.sql — DNSSEC state + the DS record to publish at the registrar.
BEGIN;

CREATE TABLE dnssec_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain          text NOT NULL,
  ds_record       text NOT NULL,
  algorithm       int  NOT NULL DEFAULT 13,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, domain)
);
CREATE INDEX idx_dnssec_org ON dnssec_keys (organization_id);

COMMIT;
