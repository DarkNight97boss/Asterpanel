-- 0005_backups_restore.up.sql — backups (manual/scheduled) and restore jobs.
BEGIN;

CREATE TABLE backups (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id       uuid REFERENCES applications(id) ON DELETE SET NULL,
  website_id           uuid REFERENCES websites(id) ON DELETE SET NULL,
  database_instance_id uuid REFERENCES database_instances(id) ON DELETE SET NULL,
  type                 text NOT NULL
                         CHECK (type IN ('full','files','database','volume')),
  trigger              text NOT NULL DEFAULT 'manual'
                         CHECK (trigger IN ('manual','scheduled')),
  schedule_cron        text,                     -- set when trigger='scheduled'
  storage_backend      text NOT NULL DEFAULT 's3'
                         CHECK (storage_backend IN ('s3','local','b2','gcs')),
  storage_location     text,                     -- object key / path
  size_bytes           bigint,
  checksum             text,                     -- sha256 of artifact
  encrypted            boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','running','completed','failed','expired')),
  job_id               uuid REFERENCES jobs(id) ON DELETE SET NULL,
  retention_days       int NOT NULL DEFAULT 30,
  started_at           timestamptz,
  completed_at         timestamptz,
  expires_at           timestamptz,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_backups_org ON backups(organization_id, created_at DESC);
CREATE INDEX idx_backups_app ON backups(application_id);
CREATE TRIGGER trg_backups_updated BEFORE UPDATE ON backups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE restore_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  backup_id             uuid NOT NULL REFERENCES backups(id) ON DELETE RESTRICT,
  target_application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','running','completed','failed')),
  job_id                uuid REFERENCES jobs(id) ON DELETE SET NULL,
  started_at            timestamptz,
  completed_at          timestamptz,
  error                 text,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restore_backup ON restore_jobs(backup_id);
CREATE TRIGGER trg_restore_updated BEFORE UPDATE ON restore_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
