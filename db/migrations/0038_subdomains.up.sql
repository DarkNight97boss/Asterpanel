-- Subdomains / addon domains / aliases — the cPanel domain taxonomy.
--   subdomain : a host under an owned zone (blog.example.com) → serves a docroot
--   addon     : a separate domain hosted here                  → serves a docroot
--   alias     : a parked domain that redirects to a target URL
-- Declarative: every change re-renders the org's Caddy `subdomains.caddy` snippet.
CREATE TABLE subdomains (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind            text NOT NULL DEFAULT 'subdomain' CHECK (kind IN ('subdomain', 'addon', 'alias')),
    fqdn            text NOT NULL,
    document_root   text NOT NULL DEFAULT '',   -- subdomain/addon
    target_url      text NOT NULL DEFAULT '',   -- alias
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'error')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, fqdn)
);

CREATE INDEX idx_subdomains_org ON subdomains (organization_id);
