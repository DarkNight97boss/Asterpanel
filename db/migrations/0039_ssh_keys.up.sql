-- SSH authorized keys for the org's SFTP/SSH access (cPanel "SSH Access").
-- Public keys only; rendered declaratively into an authorized_keys file by the
-- signed ssh.keys.apply job. The fingerprint is the SHA256 of the key blob.
CREATE TABLE ssh_keys (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            text NOT NULL,
    key_type        text NOT NULL,
    public_key      text NOT NULL,
    fingerprint     text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, fingerprint)
);

CREATE INDEX idx_ssh_keys_org ON ssh_keys (organization_id);
