-- 0046_suspension_overdue.down.sql
BEGIN;

-- Revert any overdue suspensions to 'manual' so the tighter check still holds.
UPDATE organizations SET suspension_source = 'manual' WHERE suspension_source = 'overdue';
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_suspension_source_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_suspension_source_check
  CHECK (suspension_source IN ('manual', 'cascade'));

COMMIT;
