-- 0019_dns_nameservers.up.sql — authoritative nameservers (secondary DNS).
BEGIN;

CREATE TABLE dns_nameservers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname   text NOT NULL,
  ipv4       inet,
  label      text,
  sort       int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Default fleet nameservers (operators replace these with their real hosts/IPs).
INSERT INTO dns_nameservers (hostname, ipv4, label, sort) VALUES
  ('ns1.asterpanel.io', '203.0.113.53',  'Primary',   1),
  ('ns2.asterpanel.io', '198.51.100.53', 'Secondary', 2);

COMMIT;
