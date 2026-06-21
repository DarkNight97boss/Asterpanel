-- 0046_suspension_overdue.up.sql — let dunning record that an org was suspended
-- for non-payment ('overdue'), distinct from a manual or cascade suspension, so
-- paying the invoice can auto-reactivate exactly those orgs.
BEGIN;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_suspension_source_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_suspension_source_check
  CHECK (suspension_source IN ('manual', 'cascade', 'overdue'));

COMMIT;
