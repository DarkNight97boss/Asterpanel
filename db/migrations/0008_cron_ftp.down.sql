BEGIN;
DROP TABLE IF EXISTS ftp_accounts;
DROP TABLE IF EXISTS cron_jobs;
DELETE FROM permissions WHERE key IN ('cron.read','cron.manage','ftp.read','ftp.manage');
COMMIT;
