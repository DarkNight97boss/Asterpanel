BEGIN;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS fk_org_billing_plan;
DROP TABLE IF EXISTS billing_plans;
DROP TABLE IF EXISTS notifications;
DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_logs;
DROP TRIGGER IF EXISTS trg_audit_no_delete ON audit_logs;
DROP TABLE IF EXISTS audit_logs;
DROP FUNCTION IF EXISTS audit_logs_immutable();
COMMIT;
