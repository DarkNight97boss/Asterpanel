-- 0020_waf_rules.up.sql — application-layer WAF rules (reuses firewall.* perms).
BEGIN;

CREATE TABLE waf_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  match_type      text NOT NULL CHECK (match_type IN ('path','user_agent','ip')),
  pattern         text NOT NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_waf_org ON waf_rules (organization_id);

COMMIT;
