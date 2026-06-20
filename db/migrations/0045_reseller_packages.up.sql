-- 0045_reseller_packages.up.sql — let a reseller define its OWN hosting
-- packages (plan templates) for its customers. owner_org_id NULL = a
-- platform/global plan (managed by the operator); non-NULL = owned by that
-- reseller org and only visible/assignable within its subtree.
BEGIN;

ALTER TABLE billing_plans
  ADD COLUMN IF NOT EXISTS owner_org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_billing_plans_owner ON billing_plans (owner_org_id);

COMMIT;
