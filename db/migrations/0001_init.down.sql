BEGIN;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS webauthn_credentials;
DROP TABLE IF EXISTS totp_secrets;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organizations;
DROP FUNCTION IF EXISTS set_updated_at();
-- extensions (pgcrypto, citext) are left installed intentionally.
COMMIT;
