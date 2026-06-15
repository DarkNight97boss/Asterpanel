-- 0014_health_incidents.up.sql — open/closed health incidents per site.
BEGIN;

CREATE TABLE health_incidents (
  id              bigserial PRIMARY KEY,
  website_id      uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  http_code       int
);
-- At most one open incident per site.
CREATE UNIQUE INDEX uq_incident_open ON health_incidents (website_id) WHERE closed_at IS NULL;
CREATE INDEX idx_incident_org_time ON health_incidents (organization_id, opened_at DESC);

COMMIT;
