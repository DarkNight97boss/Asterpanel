-- 0001_init.up.sql — extensions, tenancy, identity, RBAC, sessions, MFA, API tokens.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email/domains

-- Shared helper: keep updated_at fresh on UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Organizations (tenants) ─────────────────────────────────────────────────
CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            citext NOT NULL UNIQUE,
  name            text   NOT NULL,
  status          text   NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deleted')),
  billing_plan_id uuid,  -- FK added in 0006 (billing_plans)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE TRIGGER trg_org_updated BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                citext NOT NULL UNIQUE,
  email_verified_at    timestamptz,
  password_hash        text   NOT NULL,                 -- Argon2id PHC string
  password_updated_at  timestamptz NOT NULL DEFAULT now(),
  full_name            text,
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','suspended','locked','deleted')),
  failed_login_count   int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  is_superadmin        boolean NOT NULL DEFAULT false,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RBAC: roles, permissions, mapping ───────────────────────────────────────
CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = system role
  name            text NOT NULL,
  description     text,
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE UNIQUE INDEX uq_roles_system_name ON roles(name) WHERE organization_id IS NULL;
CREATE TRIGGER trg_roles_updated BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,        -- e.g. 'website.create'
  description text NOT NULL,
  category    text NOT NULL                -- e.g. 'website','dns','node'
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ── Membership: user ↔ organization with a role ─────────────────────────────
CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','invited','suspended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);
CREATE INDEX idx_memberships_org ON memberships(organization_id);
CREATE TRIGGER trg_memberships_updated BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Sessions ────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  user_agent      text,
  ip              inet,
  mfa_satisfied   boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text
);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

-- ── Refresh tokens (rotation family + reuse detection) ──────────────────────
CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id     uuid NOT NULL,                 -- all rotations share a family
  token_hash    bytea NOT NULL UNIQUE,         -- sha256(token)
  prev_token_id uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  rotated_at    timestamptz,                   -- set the moment it is consumed/rotated
  revoked_at    timestamptz,
  revoked_reason text
);
CREATE INDEX idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX idx_refresh_session ON refresh_tokens(session_id);

-- ── MFA: TOTP secrets ───────────────────────────────────────────────────────
CREATE TABLE totp_secrets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted bytea NOT NULL,             -- envelope-encrypted base32 secret
  nonce            bytea NOT NULL,
  key_id           text  NOT NULL,
  digits           int   NOT NULL DEFAULT 6,
  period           int   NOT NULL DEFAULT 30,
  algorithm        text  NOT NULL DEFAULT 'SHA1',
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

-- ── MFA: WebAuthn / Passkeys ────────────────────────────────────────────────
CREATE TABLE webauthn_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,
  public_key    bytea NOT NULL,
  aaguid        uuid,
  sign_count    bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX idx_webauthn_user ON webauthn_credentials(user_id);

-- ── Scoped API tokens ───────────────────────────────────────────────────────
CREATE TABLE api_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,   -- creator
  name            text NOT NULL,
  prefix          text NOT NULL UNIQUE,        -- fast lookup prefix
  token_hash      bytea NOT NULL UNIQUE,       -- sha256(full token)
  scopes          text[] NOT NULL DEFAULT '{}',
  last_used_at    timestamptz,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

COMMIT;
