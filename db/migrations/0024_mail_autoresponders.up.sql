-- 0024_mail_autoresponders.up.sql — per-address vacation auto-replies (Sieve).
BEGIN;

CREATE TABLE mail_autoresponders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  address         text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  interval_days   int  NOT NULL DEFAULT 1,
  start_date      date,
  end_date        date,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, address)
);
CREATE INDEX idx_mail_autoresponders_org ON mail_autoresponders (organization_id);

COMMIT;
