-- 0002_nodes_jobs.up.sql — server nodes, agent enrollment, metrics, dispatched jobs.
BEGIN;

-- ── Server nodes ────────────────────────────────────────────────────────────
CREATE TABLE server_nodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  hostname          text NOT NULL,
  region            text,
  ip_address        inet,
  agent_version     text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','online','offline','draining','decommissioned')),
  labels            jsonb NOT NULL DEFAULT '{}',
  capabilities      jsonb NOT NULL DEFAULT '{}',
  cert_fingerprint  text,                       -- mTLS client cert fingerprint
  last_heartbeat_at timestamptz,
  enrolled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (organization_id, name)
);
CREATE TRIGGER trg_nodes_updated BEFORE UPDATE ON server_nodes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Agent enrollment (one-time bootstrap token → CSR → signed cert) ─────────
CREATE TABLE agent_registrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_node_id        uuid NOT NULL REFERENCES server_nodes(id) ON DELETE CASCADE,
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enrollment_token_hash bytea NOT NULL UNIQUE,  -- sha256(bootstrap token)
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','used','expired','revoked')),
  csr_pem               text,
  cert_pem              text,
  cert_serial           text,
  cert_fingerprint      text,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_reg_node ON agent_registrations(server_node_id);
CREATE TRIGGER trg_agentreg_updated BEFORE UPDATE ON agent_registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Node metrics (time series; would be a Timescale hypertable in prod) ──────
CREATE TABLE node_metrics (
  id                bigserial PRIMARY KEY,
  server_node_id    uuid NOT NULL REFERENCES server_nodes(id) ON DELETE CASCADE,
  collected_at      timestamptz NOT NULL DEFAULT now(),
  cpu_pct           double precision,
  mem_used_bytes    bigint,
  mem_total_bytes   bigint,
  disk_used_bytes   bigint,
  disk_total_bytes  bigint,
  load1             double precision,
  containers_running int,
  payload           jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_node_metrics_node_ts ON node_metrics(server_node_id, collected_at DESC);

-- ── Dispatched signed jobs (control plane → agent) ──────────────────────────
CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  server_node_id  uuid REFERENCES server_nodes(id) ON DELETE SET NULL,
  type            text NOT NULL,               -- e.g. 'website.create'
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','dispatched','accepted','running',
                                      'succeeded','failed','expired','canceled')),
  nonce           text NOT NULL UNIQUE,        -- anti-replay
  signature       text NOT NULL,               -- base64 Ed25519
  signing_key_id  text NOT NULL,
  idempotency_key text,
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,        -- short TTL
  dispatched_at   timestamptz,
  accepted_at     timestamptz,
  completed_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  result          jsonb,
  error           text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_node_status ON jobs(server_node_id, status);
CREATE INDEX idx_jobs_org_created ON jobs(organization_id, created_at DESC);
CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
