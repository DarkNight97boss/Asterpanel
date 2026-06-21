-- 0047_support_tickets.down.sql
BEGIN;

DROP TABLE IF EXISTS support_ticket_messages;
DROP TABLE IF EXISTS support_tickets;
DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('support.read','support.manage'));
DELETE FROM permissions WHERE key IN ('support.read','support.manage');

COMMIT;
