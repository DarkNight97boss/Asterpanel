# AsterPanel — Commercial parity roadmap (Plesk/cPanel-level)

Goal: a **commercial hosting panel** at parity with Plesk. We build it as **real
vertical slices**, each following the same pattern and each shipped only when it
compiles and its tests pass:

> **UI (exists) → Go endpoint (RBAC + OPA + audit) → signed job (Ed25519/mTLS) → Rust executor on the node**

Status legend: ✅ done · 🟡 in progress · ⬜ planned.

## Phase 1 — Hosting core (turn the 🟡 UI into real features)
1. ✅ **Domains & DNS** — domain CRUD, authoritative zones, records; `dns.apply` writes BIND zone files on the node. *(done; live DNS server reload is the next refinement)*
2. ⬜ **SSL/TLS** — per-domain ACME issuance/renewal via the agent + Caddy; custom cert upload.
3. ⬜ **Deploy from Git** — `app.deploy` executor: clone → build → image → run → health-check → atomic proxy swap → rollback.
4. ⬜ **Backups & Restore** — real artifacts (tar/dump) to S3/B2/local, checksums, retention, scheduled + one-click restore.
5. ⬜ **Cron jobs** — schema + executor running inside the site container with limits.
6. ⬜ **FTP/SFTP** — `ftp_accounts` schema + executor provisioning chrooted SFTP users.
7. ⬜ **File Manager** — agent file API (list/read/write/upload/delete) scoped to a site.
8. ⬜ **Env & Secrets CRUD** — endpoints over the existing schema + envelope crypto.
9. ⬜ **Database users & admin** — separate DB users/grants, Adminer/phpMyAdmin per instance.
10. ⬜ **Runtime manager** — multi-PHP/Node version switch (redeploys the container).

## Phase 2 — Email stack (the biggest cPanel surface)
11. ⬜ **Mail server** — Postfix + Dovecot provisioning per node; `mailboxes` schema.
12. ⬜ **Webmail** — Roundcube container wired to the mailboxes.
13. ⬜ **Forwarders, aliases, autoresponders, filters.**
14. ⬜ **Deliverability** — DKIM/SPF/DMARC management, SpamAssassin/Rspamd antispam.

## Phase 3 — Operations & security
15. ⬜ **Metrics & logs (real)** — agent collects node/container metrics → Prometheus; log streaming to the panel via Loki.
16. ⬜ **WAF + IP blocker + fail2ban-style** brute-force protection.
17. ⬜ **Health checks & alerting** — per-app probes, notifications, incident timeline.
18. ⬜ **Antivirus/malware scan** (ClamAV) on uploads + on demand.

## Phase 4 — Commercial layer
19. ⬜ **Reseller hierarchy + packages/quotas** (disk, bandwidth, mailbox, DB limits).
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
