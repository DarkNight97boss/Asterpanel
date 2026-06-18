-- 0033_db_remote_hosts.up.sql — allowed remote hosts for a database (Remote SQL).
BEGIN;

CREATE TABLE db_remote_hosts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  database_id     uuid NOT NULL,
  host            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (database_id, host)
);
CREATE INDEX idx_db_remote_org ON db_remote_hosts (organization_id);

COMMIT;
