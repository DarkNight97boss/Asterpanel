# AsterPanel — Commercial parity roadmap (Plesk/cPanel-level)

Goal: a **commercial hosting panel** at parity with Plesk. We build it as **real
vertical slices**, each following the same pattern and each shipped only when it
compiles and its tests pass:

> **UI (exists) → Go endpoint (RBAC + OPA + audit) → signed job (Ed25519/mTLS) → Rust executor on the node**

Status legend: ✅ done · 🟡 in progress · ⬜ planned.

## Phase 1 — Hosting core (turn the 🟡 UI into real features)
1. ✅ **Domains & DNS** — domain CRUD, authoritative zones, records; `dns.apply` writes BIND zone files on the node. *(done; live DNS server reload is the next refinement)*
2. ✅ **SSL/TLS** — `cert.issue` writes a Caddy site (automatic HTTPS via ACME). *(custom cert upload + renewal tracking next)*
3. ✅ **Deploy from Git** — `app.deploy`: git clone → docker build → hardened run, prior image retained for rollback. *(buildpacks for static/node/php + atomic proxy swap next)*
4. ✅ **Backups & Restore** — `backup.create`/`backup.restore` tar/untar the target. *(S3/B2 upload + checksums + scheduling next)*
5. ✅ **Cron jobs** — `cron_jobs` schema + CRUD + `cron.apply` writes the node crontab.
6. ✅ **FTP/SFTP** — `ftp_accounts` schema + CRUD + `ftp.account.create` writes a chrooted OpenSSH SFTP `Match` block.
7. ✅ **File Manager** — site-scoped, sandboxed agent file API (`file.list`/`file.read`/`file.write`/`file.mkdir`/`file.delete`) with path-traversal & symlink-escape protection and read/write size caps; integrated browse/edit/upload/delete UI. *(multipart streaming upload + archive extract next)*
8. ✅ **Env & Secrets CRUD** — org-scoped endpoints over the existing schema; secrets sealed with envelope crypto (AES-256-GCM, AAD-bound) and never returned in plaintext.
9. ✅ **Database users** — `database.user.create` runs `CREATE USER` in the DB container (Postgres). *(Adminer/phpMyAdmin + MySQL/Mongo next)*
10. ✅ **Runtime manager** — per-site Node (18/20/22) and PHP (8.1–8.4) version switch; catalog-validated endpoint → signed `runtime.switch` recreates the container from the matching base image (version sanitized before the image tag). **Phase 1 complete.** *(buildpack-style auto-detect next)*

## Phase 2 — Email stack (the biggest cPanel surface)
11. 🟡 **Mail server** — `mail.mailbox.create` writes Dovecot/Postfix config + `mail.server.ensure` launches a docker-mailserver container that reads it. *(full DMS tuning + DKIM signing + antispam next)*
12. ✅ **Webmail** — **native** integrated IMAP/SMTP client (no Roundcube): Go gateway (`go-imap`/`go-message`) + Next.js UI (folders, read, compose/send); GreenMail dev server in compose. *(running Postfix/Dovecot per node next)*
13. ⬜ **Forwarders, aliases, autoresponders, filters.**
14. ⬜ **Deliverability** — DKIM/SPF/DMARC management, SpamAssassin/Rspamd antispam.

## Phase 3 — Operations & security
15. ✅ **Metrics & logs (real)** — agent samples CPU/mem/disk/load every 15s → CP (`node_metrics` time series), `GET /metrics` aggregates the fleet; signed `logs.tail` → `docker logs` powers a per-site log viewer (site picker, tail size, auto-refresh). *(container-level metrics + Loki streaming next)*
16. 🟡 **Firewall + WAF + IP blocker** — `firewall.apply` renders/loads an `nft` ruleset (`table inet asterpanel`) per node; a **fail2ban-style watch** auto-bans source IPs with too many failed logins (firewall deny rule + notification). *(application-layer WAF rules next)*
17. ✅ **Health checks & alerting** — signed `health.check` probes (liveness + optional HTTP); a 60s background sweep re-probes the fleet, opens/closes incidents (`health_incidents`) and notifies on transitions; Health panel shows status + incident timeline. *(HTTP probe target from the site domain + paging/webhooks next)*
18. ⬜ **Antivirus/malware scan** (ClamAV) on uploads + on demand.

## Phase 4 — Commercial layer
19. 🟡 **Reseller hierarchy + packages/quotas** — per-plan `limits` (sites/domains/databases/nodes/mailboxes) enforced on every create (`403 quota_exceeded`); `GET /billing` exposes plan + usage. *(reseller sub-accounts + disk/bandwidth metering next)*
20. ⬜ **Billing & invoicing** — usage metering, plans, invoices, payment-provider hooks.
21. ⬜ **White-label / branding**, customer-facing API + webhooks, docs portal.
22. ⬜ **Migration tooling** — import from cPanel/Plesk.
23. ⬜ **DNS clustering / secondary DNS**, multi-region.

## Intentional divergences from cPanel (by design — not gaps)
- No direct host SSH/shell; everything is a signed, audited job. (A sandboxed
  *web terminal into a container* may be added; raw host shell stays out.)
- No shared-hosting "account on a box"; every site/app is an isolated container.
- No Apache/.htaccess; Caddy/Traefik + per-container config.
- Hard control-plane / data-plane split (cPanel is monolithic).

## Working agreement
- One slice at a time, each verified (`go test`, `cargo test`, `opa test`, `next build`).
- Honest status in the README table; nothing marked ✅ until it builds end-to-end.
