-- 0044_org_suspension_source.up.sql — track WHY an org is suspended, so a
-- reseller's cascade suspend/reactivate doesn't clobber a child that was
-- suspended on its own. NULL = not suspended for this reason; 'manual' = an
-- operator suspended this org directly; 'cascade' = suspended because an
-- ancestor reseller was suspended.
BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS suspension_source text
  CHECK (suspension_source IN ('manual', 'cascade'));

COMMIT;
