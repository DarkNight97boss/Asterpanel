BEGIN;
DROP TABLE IF EXISTS mailboxes;
DROP TABLE IF EXISTS ssl_certificates;
DELETE FROM permissions WHERE key IN ('ssl.read','ssl.manage','email.read','email.manage');
COMMIT;
