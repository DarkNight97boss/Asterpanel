-- 0022_backup_schedules.up.sql — recurring backup schedules (reuses backup.* perms).
BEGIN;

CREATE TABLE backup_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  frequency       text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','weekly')),
  retention_days  int  NOT NULL DEFAULT 30,
  enabled         boolean NOT NULL DEFAULT true,
  last_run_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_backup_sched_org ON backup_schedules (organization_id);

COMMIT;
