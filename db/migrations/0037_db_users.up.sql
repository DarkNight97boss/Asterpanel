-- Database users: named login roles on a managed database instance, each with a
-- specific privilege set (the cPanel "MySQL Databases" users model). The password
-- is stored only envelope-encrypted in `secrets`; CREATE USER / GRANT / DROP USER
-- are applied on the node by a signed database.user.* job.
CREATE TABLE db_users (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    database_id           uuid NOT NULL REFERENCES database_instances(id) ON DELETE CASCADE,
    username              text NOT NULL,
    host_scope            text NOT NULL DEFAULT '%',          -- MySQL '<user>'@'<host>'; ignored for Postgres
    privileges            text[] NOT NULL DEFAULT ARRAY['ALL'],
    credentials_secret_id uuid REFERENCES secrets(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (database_id, username, host_scope)
);

CREATE INDEX idx_db_users_database ON db_users (organization_id, database_id);
