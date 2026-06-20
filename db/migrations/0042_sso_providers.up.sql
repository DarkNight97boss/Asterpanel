-- OpenID Connect single sign-on. An org configures an external IdP (issuer +
-- client credentials); the panel runs the Authorization Code flow with PKCE and
-- validates the IdP's signed ID token (RS256 via the issuer's JWKS) before
-- establishing a session. The client secret is stored envelope-encrypted (AEAD),
-- never in plaintext.
CREATE TABLE sso_providers (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                 text NOT NULL,
    issuer               text NOT NULL,
    client_id            text NOT NULL,
    client_secret_ct     bytea NOT NULL,
    client_secret_nonce  bytea NOT NULL,
    client_secret_keyid  text NOT NULL,
    allowed_domains      text NOT NULL DEFAULT '',   -- comma-separated email domains
    enabled              boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, issuer)
);

CREATE INDEX idx_sso_providers_org ON sso_providers (organization_id);
