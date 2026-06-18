-- 0029_mail_spam.up.sql — Rspamd spam settings + allow/deny sender lists.
BEGIN;

CREATE TABLE mail_spam_settings (
  organization_id  uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  reject_score     int NOT NULL DEFAULT 15,
  add_header_score int NOT NULL DEFAULT 6,
  greylisting      boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_spam_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('allow','deny')),
  value           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind, value)
);
CREATE INDEX idx_mail_spam_rules_org ON mail_spam_rules (organization_id);

COMMIT;
