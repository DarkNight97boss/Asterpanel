-- 0013_site_health.up.sql — latest health snapshot per site.
BEGIN;

CREATE TABLE site_health (
  website_id           uuid PRIMARY KEY REFERENCES websites(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'unknown'
                         CHECK (status IN ('up','down','unknown')),
  http_code            int,
  latency_ms           int,
  consecutive_failures int NOT NULL DEFAULT 0,
  checked_at           timestamptz NOT NULL DEFAULT now()
);

COMMIT;
