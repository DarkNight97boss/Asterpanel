-- 0004_apps_deploys.up.sql — websites, applications, deployments, env, secrets, DBs, health.
BEGIN;

CREATE TABLE websites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  server_node_id    uuid REFERENCES server_nodes(id) ON DELETE SET NULL,
  primary_domain_id uuid REFERENCES domains(id) ON DELETE SET NULL,
  name              text NOT NULL,
  runtime           text NOT NULL
                      CHECK (runtime IN ('static','node','php','docker','proxy')),
  status            text NOT NULL DEFAULT 'provisioning'
                      CHECK (status IN ('provisioning','active','suspended','error','deleting')),
  document_root     text,
  ssl_enabled       boolean NOT NULL DEFAULT true,
  ssl_status        text NOT NULL DEFAULT 'pending'
                      CHECK (ssl_status IN ('pending','issuing','active','error','disabled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (organization_id, name)
);
CREATE INDEX idx_websites_node ON websites(server_node_id);
CREATE TRIGGER trg_websites_updated BEFORE UPDATE ON websites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_id         uuid REFERENCES websites(id) ON DELETE CASCADE,
  server_node_id     uuid REFERENCES server_nodes(id) ON DELETE SET NULL,
  name               text NOT NULL,
  runtime            text NOT NULL
                       CHECK (runtime IN ('static','node','php','docker')),
  repo_url           text,
  repo_branch        text DEFAULT 'main',
  install_command    text,
  build_command      text,
  start_command      text,
  root_directory     text DEFAULT '/',
  container_image    text,                       -- last successfully built image
  container_id       text,                       -- current running container on node
  port               int,
  desired_replicas   int NOT NULL DEFAULT 1,
  resource_cpu_millis int NOT NULL DEFAULT 500,
  resource_memory_mb int NOT NULL DEFAULT 512,
  status             text NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created','building','deploying','running','stopped','error')),
  health_check_path  text DEFAULT '/',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  UNIQUE (organization_id, name)
);
CREATE INDEX idx_applications_website ON applications(website_id);
CREATE TRIGGER trg_applications_updated BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE deployments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sequence        int  NOT NULL,                 -- per-app incrementing number
  trigger         text NOT NULL DEFAULT 'manual'
                    CHECK (trigger IN ('manual','git_push','api','rollback','schedule')),
  source_type     text NOT NULL
                    CHECK (source_type IN ('git','archive','image')),
  git_ref         text,
  git_commit_sha  text,
  image_tag       text,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','building','deploying','active','failed',
                                      'superseded','canceled','rolled_back')),
  is_current      boolean NOT NULL DEFAULT false,
  rollback_of     uuid REFERENCES deployments(id) ON DELETE SET NULL,
  job_id          uuid REFERENCES jobs(id) ON DELETE SET NULL,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, sequence)
);
-- at most one current deployment per application
CREATE UNIQUE INDEX uq_deploy_current ON deployments(application_id) WHERE is_current;
CREATE TRIGGER trg_deployments_updated BEFORE UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE deployment_logs (
  id            bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  seq           bigint NOT NULL,
  ts            timestamptz NOT NULL DEFAULT now(),
  stream        text NOT NULL DEFAULT 'stdout'
                  CHECK (stream IN ('stdout','stderr','system')),
  phase         text,                            -- build|deploy|healthcheck
  message       text NOT NULL,
  UNIQUE (deployment_id, seq)
);

CREATE TABLE environment_variables (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  key             text NOT NULL,
  value           text NOT NULL,
  is_build_time   boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, key)
);
CREATE TRIGGER trg_env_updated BEFORE UPDATE ON environment_variables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Secrets are stored envelope-encrypted (AES-256-GCM); plaintext never lands here.
CREATE TABLE secrets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id  uuid REFERENCES applications(id) ON DELETE CASCADE,
  key             text NOT NULL,
  ciphertext      bytea NOT NULL,                -- AEAD ciphertext
  nonce           bytea NOT NULL,                -- AEAD nonce
  key_id          text  NOT NULL,                -- envelope/data-key id
  version         int   NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, key)
);
CREATE TRIGGER trg_secrets_updated BEFORE UPDATE ON secrets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE database_instances (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id        uuid REFERENCES applications(id) ON DELETE SET NULL,
  server_node_id        uuid REFERENCES server_nodes(id) ON DELETE SET NULL,
  engine                text NOT NULL
                          CHECK (engine IN ('postgres','mysql','mariadb','redis','mongodb')),
  version               text,
  name                  text NOT NULL,
  db_user               text,
  credentials_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
  host                  text,
  port                  int,
  status                text NOT NULL DEFAULT 'provisioning'
                          CHECK (status IN ('provisioning','running','stopped','error','deleting')),
  size_mb               bigint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  UNIQUE (organization_id, name)
);
CREATE TRIGGER trg_dbinst_updated BEFORE UPDATE ON database_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE health_checks (
  id              bigserial PRIMARY KEY,
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL CHECK (status IN ('healthy','unhealthy','unknown')),
  http_status     int,
  latency_ms      int,
  detail          text
);
CREATE INDEX idx_health_app_ts ON health_checks(application_id, checked_at DESC);

COMMIT;
