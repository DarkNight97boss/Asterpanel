-- 0023_mail_forwarders.up.sql — email forwarders / aliases (incl. catch-all).
BEGIN;

CREATE TABLE mail_forwarders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source          text NOT NULL,
  destinations    text[] NOT NULL,
  is_catchall     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source)
);
CREATE INDEX idx_mail_forwarders_org ON mail_forwarders (organization_id);

COMMIT;
