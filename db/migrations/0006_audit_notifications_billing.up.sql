-- 0006_audit_notifications_billing.up.sql — append-only audit log, notifications, billing.
BEGIN;

-- ── Append-only, hash-chained audit log ─────────────────────────────────────
-- The application computes prev_hash/hash under a per-org advisory lock so each
-- organization gets a verifiable chain. The DB enforces immutability.
CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,         -- monotonic insertion order
  organization_id uuid,                          -- NULL = system-level event
  actor_user_id   uuid,
  actor_type      text NOT NULL DEFAULT 'user'
                    CHECK (actor_type IN ('user','system','agent','api_token')),
  actor_token_id  uuid,
  session_id      uuid,
  action          text NOT NULL,                 -- e.g. 'website.create'
  resource_type   text,
  resource_id     text,
  outcome         text NOT NULL DEFAULT 'success'
                    CHECK (outcome IN ('success','failure','denied')),
  ip              inet,
  user_agent      text,
  request_id      text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  prev_hash       bytea,                         -- previous row's hash in this org chain
  hash            bytea NOT NULL,                -- sha256(prev_hash || canonical(this row))
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org_created ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);

-- Immutability: block UPDATE and DELETE at the database level.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% not permitted)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ── Notifications ───────────────────────────────────────────────────────────
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL,                 -- e.g. 'deploy.succeeded'
  severity        text NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info','success','warning','error')),
  title           text NOT NULL,
  body            text,
  resource_type   text,
  resource_id     text,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_user_unread ON notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;

-- ── Billing plans (optional) ────────────────────────────────────────────────
CREATE TABLE billing_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  price_cents int  NOT NULL DEFAULT 0,
  currency    text NOT NULL DEFAULT 'EUR',
  interval    text NOT NULL DEFAULT 'month' CHECK (interval IN ('month','year')),
  limits      jsonb NOT NULL DEFAULT '{}',       -- {"max_sites":10,"max_nodes":2,...}
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_billing_updated BEFORE UPDATE ON billing_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- now that billing_plans exists, wire the FK left dangling in 0001
ALTER TABLE organizations
  ADD CONSTRAINT fk_org_billing_plan
  FOREIGN KEY (billing_plan_id) REFERENCES billing_plans(id) ON DELETE SET NULL;

COMMIT;
