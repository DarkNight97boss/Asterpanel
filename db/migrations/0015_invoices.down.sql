-- 0015_invoices.down.sql
BEGIN;

DROP TABLE IF EXISTS invoice_line_items;
DROP TABLE IF EXISTS invoices;
DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key = 'billing.manage');
DELETE FROM permissions WHERE key = 'billing.manage';

COMMIT;
