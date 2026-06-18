-- 0034_mail_lists.up.sql — mailing lists (an address that fans out to members).
BEGIN;

CREATE TABLE mail_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  address         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, address)
);

CREATE TABLE mail_list_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id    uuid NOT NULL REFERENCES mail_lists(id) ON DELETE CASCADE,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (list_id, email)
);
CREATE INDEX idx_mail_lists_org ON mail_lists (organization_id);
CREATE INDEX idx_mail_list_members_list ON mail_list_members (list_id);

COMMIT;
