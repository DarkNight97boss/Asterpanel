-- 0025_mail_filters.up.sql — per-mailbox Sieve filter rules.
BEGIN;

CREATE TABLE mail_filters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  address         text NOT NULL,
  name            text NOT NULL,
  field           text NOT NULL CHECK (field IN ('from','to','subject','cc')),
  op              text NOT NULL CHECK (op IN ('contains','is','matches')),
  value           text NOT NULL,
  action          text NOT NULL CHECK (action IN ('fileinto','discard','redirect','keep')),
  action_arg      text NOT NULL DEFAULT '',
  position        int  NOT NULL DEFAULT 0,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mail_filters_org ON mail_filters (organization_id);

COMMIT;
