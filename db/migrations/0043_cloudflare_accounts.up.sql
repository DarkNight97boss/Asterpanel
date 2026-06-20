-- Cloudflare CDN / DNS integration. An org connects a Cloudflare API token; the
-- control plane then calls the Cloudflare API on its behalf to list zones, manage
-- DNS records and purge the CDN cache. The token is stored envelope-encrypted
-- (AEAD), never in plaintext. One connected account per org.
CREATE TABLE cloudflare_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    label           text NOT NULL DEFAULT '',
    token_ct        bytea NOT NULL,
    token_nonce     bytea NOT NULL,
    token_keyid     text NOT NULL,
    verified_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
