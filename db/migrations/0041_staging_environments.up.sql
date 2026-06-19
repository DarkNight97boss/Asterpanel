-- Staging environments: an isolated, file-level copy of a site's document root so
-- changes can be tested before being promoted to production. The actual mirror is
-- performed on the node by the signed staging.create / staging.promote /
-- staging.destroy jobs; this row tracks the environment's lifecycle for the panel.
-- status: creating | ready | promoting | error. last_job_id links the most recent
-- dispatched job so its agent callback can flip the status (ready / error).
CREATE TABLE staging_environments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    website_id      uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
    status          text NOT NULL DEFAULT 'creating',
    last_job_id     uuid,
    last_synced_at  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (website_id)
);

CREATE INDEX idx_staging_environments_org ON staging_environments (organization_id);
CREATE INDEX idx_staging_environments_job ON staging_environments (last_job_id);
