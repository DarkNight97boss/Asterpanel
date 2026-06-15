-- 0003_domains_dns.up.sql — domains, DNS zones and records.
BEGIN;

CREATE TABLE domains (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fqdn                citext NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','verifying','active','failed','disabled')),
  verification_method text CHECK (verification_method IN ('dns-01','http-01')),
  verification_token  text,
  verified_at         timestamptz,
  auto_renew          boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX idx_domains_org ON domains(organization_id);
CREATE TRIGGER trg_domains_updated BEFORE UPDATE ON domains
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dns_zones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain_id       uuid REFERENCES domains(id) ON DELETE CASCADE,
  name            citext NOT NULL UNIQUE,        -- zone apex
  provider        text NOT NULL DEFAULT 'internal',
  serial          bigint NOT NULL DEFAULT 1,
  ttl_default     int NOT NULL DEFAULT 3600,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','pending','error','disabled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_dnszones_updated BEFORE UPDATE ON dns_zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dns_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dns_zone_id     uuid NOT NULL REFERENCES dns_zones(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,                 -- record name (relative or FQDN)
  type            text NOT NULL
                    CHECK (type IN ('A','AAAA','CNAME','MX','TXT','SRV','NS','CAA','PTR')),
  content         text NOT NULL,
  ttl             int NOT NULL DEFAULT 3600,
  priority        int,                           -- MX / SRV
  proxied         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dns_zone_id, name, type, content)
);
CREATE INDEX idx_dns_records_zone ON dns_records(dns_zone_id);
CREATE TRIGGER trg_dnsrecords_updated BEFORE UPDATE ON dns_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
