# AsterPanel

> A cloud-native, security-first hosting control panel. A modern, modular alternative to cPanel / Plesk — built around a hard **control plane / data plane** separation, signed-and-authorized jobs, and zero direct shell access from the backend.

[![CI](https://github.com/DarkNight97boss/Asterpanel/actions/workflows/ci.yml/badge.svg)](https://github.com/DarkNight97boss/Asterpanel/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Status](https://img.shields.io/badge/status-MVP%20foundation-orange)

---

## Table of contents

- [Why AsterPanel](#why-asterpanel)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Repository layout](#repository-layout)
- [Quick start (dev)](#quick-start-dev)
- [Database schema](#database-schema)
- [The signed-job protocol](#the-signed-job-protocol)
- [Node enrollment](#node-enrollment)
- [API](#api)
- [Testing](#testing)
- [Implementation status](#implementation-status)
- [Roadmap](#roadmap)
- [License](#license)

---

## Why AsterPanel

Traditional panels (cPanel, Plesk) run privileged code on the same box they manage, drive
everything through shell commands, and have a flat trust model. AsterPanel is built on
different principles:

| Principle | How AsterPanel does it |
|---|---|
| **Control / data plane split** | A stateless **Control Plane** (Go) holds no production workloads. A **Node Agent** (Rust) runs on each hosting server and is the *only* thing that touches the host. |
| **No direct shell from the backend** | The Control Plane never runs shell commands. It emits **signed, authorized, TTL-bound jobs**; the Agent validates and executes them through typed executors. |
| **Every action is signed, authorized, and audited** | Jobs are Ed25519-signed, checked against **OPA** policy, replay-protected by nonces, and written to an **append-only, hash-chained audit log**. |
| **Tenant isolation by default** | Every site/app runs in its own non-privileged container with seccomp/AppArmor profiles, user namespaces, resource limits, and per-tenant network isolation. |
| **Modern auth** | OIDC-ready, short-lived JWTs, refresh-token rotation with reuse detection, Passkeys/WebAuthn, TOTP, scoped API tokens. |
| **Cloud-native from day one** | Docker today; the Agent's executor is an interface, so containerd/Kubernetes back-ends drop in without touching the Control Plane. |

## Architecture

```
                          ┌────────────────────────────────────────────────────┐
                          │                     CONTROL PLANE                    │
   Browser                │                                                      │
  ┌────────┐   HTTPS      │  ┌────────────┐   ┌──────────────┐   ┌────────────┐  │
  │  Web   │─────────────▶│  │ API Gateway│──▶│ Control Plane│──▶│    OPA     │  │
  │ Panel  │  (Caddy/     │  │  (Caddy)   │   │     (Go)     │   │  policies  │  │
  │ Next15 │   Traefik)   │  └────────────┘   └──────┬───────┘   └────────────┘  │
  └────────┘              │                          │                           │
                          │       ┌──────────┬───────┼───────┬──────────┐        │
                          │       ▼          ▼       ▼       ▼          ▼        │
                          │  ┌────────┐ ┌────────┐ ┌─────┐ ┌──────┐ ┌────────┐   │
                          │  │Postgres│ │ Redis  │ │NATS │ │Vault │ │  OTel  │   │
                          │  │  (SoR) │ │(cache/ │ │(bus/│ │/SOPS │ │Prom/   │   │
                          │  │        │ │ sess/  │ │ jobs│ │secret│ │Grafana/│   │
                          │  │        │ │  rate) │ │  )  │ │ s)   │ │ Loki)  │   │
                          │  └────────┘ └────────┘ └─────┘ └──────┘ └────────┘   │
                          └─────────────────────────┬────────────────────────────┘
                                                    │  mTLS + Ed25519-signed jobs
                            ┌───────────────────────┼───────────────────────┐
                            ▼                       ▼                       ▼
                    ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
                    │  DATA PLANE  │        │  DATA PLANE  │        │  DATA PLANE  │
                    │  Node Agent  │        │  Node Agent  │        │  Node Agent  │
                    │   (Rust)     │        │   (Rust)     │        │   (Rust)     │
                    │ ┌──────────┐ │        │              │        │              │
                    │ │ executor │ │        │   per-tenant │        │              │
                    │ │  docker  │ │        │   containers │        │   ...        │
                    │ └──────────┘ │        │   (isolated) │        │              │
                    │ site │ app   │        │              │        │              │
                    └──────────────┘        └──────────────┘        └──────────────┘
```

**Request → action lifecycle**

1. User acts in the Web Panel → request hits the **API Gateway** (Caddy/Traefik) → **Control Plane**.
2. Control Plane authenticates (JWT/session), runs **RBAC + OPA** authorization, validates input.
3. For anything that touches a node, it builds a **Job**, signs it with **Ed25519**, stamps a **nonce + short TTL**, and writes an **audit** entry.
4. Job is dispatched to the target **Node Agent** over **mTLS**.
5. Agent verifies signature, checks nonce (anti-replay) and TTL, re-checks the job is for *this* node, then runs the matching **idempotent executor**.
6. Agent reports status back over mTLS; Control Plane updates state, emits a **NATS** event, and records the result in the audit log.

See [`docs/architecture.md`](docs/architecture.md) for the full design.

## Security model

A non-exhaustive list of controls that are wired into the foundation:

- **mTLS** between Control Plane and every Agent, with a project CA and pinned keys.
- **Ed25519 job signatures** over a canonical, deterministic JSON encoding.
- **Replay protection**: every job carries a unique nonce; agents reject seen nonces and expired jobs (short TTL).
- **OPA policy engine** gates both API actions and job dispatch (`policies/`).
- **Argon2id** password hashing (tuned params, per-hash salt).
- **Short-lived JWTs** + **refresh-token rotation** with **reuse detection** (compromised family revocation).
- **Session revocation** and scoped, hashed **API tokens**.
- **Append-only, hash-chained audit log** (tamper-evident).
- **Rate limiting** (Redis), **CSRF** protection on cookie flows, strict **CORS**, **security headers**.
- **Rigorous input validation** and output encoding.
- **Least privilege** everywhere: non-privileged containers, user namespaces, seccomp/AppArmor, per-container resource and network limits.
- **No secrets in logs**, **encryption at rest** for sensitive secrets (envelope encryption; Vault/SOPS-compatible).

Full analysis and STRIDE table: [`docs/threat-model.md`](docs/threat-model.md).

## Repository layout

```
asterpanel/
├── control-plane/        # Go — REST API, auth, RBAC, audit, job signer, agent dispatcher
│   ├── cmd/controlplane/ # entrypoint
│   └── internal/         # config, store, auth, rbac, audit, jobs, crypto, api, middleware
├── node-agent/           # Rust — mTLS server, job verifier, nonce store, executors (docker)
│   └── src/
├── web/                  # Next.js 15 + TS + Tailwind + shadcn/ui
│   └── src/
├── db/
│   ├── migrations/       # versioned SQL migrations (up/down)
│   └── seed.sql          # dev seed (roles, permissions, demo org/admin)
├── policies/             # OPA (Rego) policies + tests
├── api/                  # OpenAPI 3.1 spec (Swagger)
├── deploy/
│   ├── caddy/            # dynamic reverse-proxy config
│   ├── traefik/          # alternative reverse proxy
│   └── provisioning/     # node bootstrap / agent install script
├── examples/             # signed-job examples + helper CLI
├── docs/                 # architecture, threat model, security, roadmap
├── .github/workflows/    # CI/CD (Go, Rust, web, policies)
├── docker-compose.yml    # full dev environment
└── Makefile              # dev entrypoints
```

## Quick start (dev)

**Prerequisites:** Docker + Docker Compose. (For working on individual services natively
you'll also want Go ≥ 1.23, Rust ≥ 1.79, Node ≥ 20.)

```bash
# 1. clone
git clone https://github.com/DarkNight97boss/Asterpanel.git asterpanel
cd asterpanel

# 2. configure
cp .env.example .env
make secrets          # generates dev CA, Ed25519 job keys, mTLS certs into ./secrets

# 3. boot the stack (postgres, redis, nats, control-plane, agent, web, caddy, observability)
make up

# 4. apply migrations + seed
make migrate
make seed

# 5. open the panel
open http://localhost:3000        # default admin: admin@asterpanel.local / ChangeMe!123  (TOTP enrollment on first login)
```

Service URLs in dev:

| Service | URL |
|---|---|
| Web Panel | http://localhost:3000 |
| Control Plane API | http://localhost:8080 (behind gateway at `/api`) |
| Swagger UI | http://localhost:8080/swagger |
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| NATS monitor | http://localhost:8222 |
| OPA | http://localhost:8181 |

## Database schema

PostgreSQL is the single system of record. The schema covers Users, Organizations, Roles,
Permissions, API tokens, Sessions, Server Nodes, Agent registrations, Domains, DNS zones &
records, Websites, Applications, Deployments & logs, Environment variables, Secrets,
Database instances, Backups, Restore jobs, the audit log, Notifications, and (optional)
Billing plans.

Migrations live in [`db/migrations/`](db/migrations) and are applied with `golang-migrate`
(or `make migrate`). The full ERD is documented in [`docs/architecture.md`](docs/architecture.md#data-model).

## The signed-job protocol

Every instruction the Control Plane sends to an Agent is a `Job`:

```jsonc
{
  "id":        "0f9c4d2e-... (uuid)",
  "type":      "website.create",
  "node_id":   "a1b2c3d4-... (server_nodes.id)",
  "tenant_id": "5e6f7a8b-... (organizations.id)",
  "nonce":     "base64url(32 random bytes)",
  "issued_at": "2026-06-15T10:00:00Z",
  "expires_at":"2026-06-15T10:00:30Z",   // short TTL
  "payload":   { "...": "type-specific, schema-validated" }
}
```

It is serialized with a **canonical JSON encoder** (sorted keys, no insignificant
whitespace), signed with the Control Plane's **Ed25519** private key, and transmitted as:

```
POST https://<agent>:7443/v1/jobs        (over mTLS)
X-Asterpanel-Signature: ed25519=<base64 sig>
X-Asterpanel-Key-Id: <signing key id>
Content-Type: application/json
```

The Agent **(1)** validates the client cert chain, **(2)** verifies the signature against the
pinned Control-Plane public key, **(3)** rejects the job if the nonce was already seen or the
TTL elapsed, **(4)** confirms `node_id` matches itself, then **(5)** dispatches to the
idempotent executor for `type`. See runnable examples in [`examples/`](examples).

## Node enrollment

Agents are enrolled with a **one-time bootstrap token** (no long-lived shared secret):

1. Admin registers a node → Control Plane issues a single-use, short-TTL enrollment token.
2. The provisioning script ([`deploy/provisioning/install-node-agent.sh`](deploy/provisioning/install-node-agent.sh))
   installs the Agent, which generates a keypair + CSR and presents the bootstrap token.
3. Control Plane's CA signs the CSR → Agent receives its **mTLS client certificate**.
4. The bootstrap token is burned; from then on the Agent authenticates with its certificate only.

## API

The REST API is documented as **OpenAPI 3.1** in [`api/openapi.yaml`](api/openapi.yaml) and
served at `/swagger`. Every endpoint runs through authentication + authorization middleware;
mutating endpoints are CSRF-protected (cookie flows) and audit-logged.

## Testing

```bash
make test            # runs all suites
make test-go         # control-plane unit tests (crypto, signed jobs, audit chain)
make test-rust       # agent unit tests (signature verify, nonce anti-replay)
make test-web        # web unit tests (vitest)
make test-policies   # OPA policy tests (opa test)
```

CI runs the same suites per-language on every push — see [`.github/workflows/`](.github/workflows).

## Implementation status

This repository is a **real, buildable MVP foundation**, not a mock. The security-critical
core is implemented; breadth features are scaffolded behind clean interfaces.

> **Verified:** all four stacks compile and their unit tests pass —
> `go build ./...` + `go vet` + `go test` (control plane), `cargo build` + `cargo test` (agent),
> `next build` + `vitest` (web), and `opa test` (policies, 9/9). Honest status:

| Area | Status |
|---|---|
| Monorepo, Docker Compose, CI/CD, Makefile | ✅ implemented |
| DB schema + migrations + seed | ✅ implemented |
| Control Plane: config, structured logging, Postgres store | ✅ implemented |
| Auth: Argon2id, JWT, refresh rotation+reuse detection, sessions, TOTP, API tokens | ✅ implemented |
| WebAuthn/Passkeys | 🟡 DB schema (`webauthn_credentials`) in place; begin/finish endpoints not yet implemented (TOTP is the working second factor) |
| RBAC + OPA authorization middleware | ✅ implemented |
| Append-only hash-chained audit log | ✅ implemented |
| Ed25519 job signing + canonical encoding + examples | ✅ implemented |
| Agent: mTLS server, signature verify, nonce/TTL, executor interface, Docker executor | ✅ implemented |
| Node enrollment (CSR/CA flow) | ✅ implemented |
| Domains & DNS (authoritative zones + records) | ✅ API → RBAC+OPA → signed `dns.apply` job → agent renders/writes a BIND zone file on the node |
| Secondary DNS / zone replication | ✅ `dns.apply` is fanned out to **every node in the org** so each zone is replicated across the fleet (redundancy); `GET /dns/nameservers` lists the fleet nameservers (ns1/ns2) shown on the DNS page for registrar setup |
| Managed databases (Postgres/MySQL/MariaDB/Redis/Mongo) | ✅ API → RBAC+OPA → envelope-encrypted credentials → signed job → hardened-container executor (runs live on a Docker node) |
| SSL/TLS (ACME) | ✅ API → signed `cert.issue` job → agent writes a Caddy site (automatic HTTPS) |
| Email mailboxes (IMAP/SMTP) | ✅ API → sealed password → signed `mail.mailbox.create` job → agent writes Dovecot/Postfix config (running mail-server containers iterating) |
| Webmail — **native** IMAP/SMTP client (modern Roundcube alternative) | ✅ Go gateway (`go-imap`/`go-message`) + integrated Next.js UI: folders, read (text + sandboxed-iframe HTML), compose/send. Dev mail server (GreenMail) wired in compose |
| Cron jobs | ✅ CRUD → signed `cron.apply` → agent writes the node crontab |
| FTP/SFTP accounts | ✅ CRUD → sealed password → signed `ftp.account.create` → agent writes a chrooted OpenSSH SFTP `Match` block |
| Database users | ✅ `POST /databases/{id}/users` → signed `database.user.create` → agent runs `CREATE USER` inside the DB container (Postgres) |
| File manager (site-scoped) | ✅ browse/read/edit/upload/mkdir/delete → signed `file.list`/`file.read`/`file.write`/`file.mkdir`/`file.delete` jobs → agent's **sandboxed** file API (path-traversal & symlink-escape proof, 1 MiB read / 5 MiB write caps) scoped to the site's document root |
| Runtime manager | ✅ per-site language version (Node 18/20/22, PHP 8.1–8.4) → catalog-validated `POST /sites/{id}/runtime` → signed `runtime.switch` job recreates the container from the matching base image (version sanitized before it reaches an image tag) |
| Mail server (Postfix+Dovecot) | 🟡 `mail.server.ensure` launches a docker-mailserver container reading the written config (full DMS tuning + DKIM iterating) |
| Hardening | ✅ custom-cert upload (`cert.install`), off-site **S3 backup** upload (aws CLI), private keys redacted from persisted jobs |
| Deploy from Git | ✅ `app.deploy` executor: git clone → docker build → hardened run (prior image retained for rollback; Dockerfile-based, buildpacks iterating) |
| Backups & restore | ✅ API → signed `backup.create`/`backup.restore` jobs → agent tars/untars the target (S3/B2 upload iterating) |
| Environment variables & secrets | ✅ org-scoped CRUD; secrets sealed with envelope encryption (AES-256-GCM, AAD-bound) and never returned in plaintext |
| Firewall | ✅ CRUD → signed `firewall.apply` → agent renders an `nft` ruleset (`table inet asterpanel`) and loads it on the node |
| Brute-force auto-ban (fail2ban-style) | ✅ a 60s control-plane watch groups failed `auth.login`/`auth.mfa` audit events by source IP; an IP over threshold (5 in 15m) gets an **auto-ban** deny rule (reusing the firewall vertical) applied to each org's nodes, plus an audit entry + notification; flagged in the Firewall UI |
| Plan quotas & billing | ✅ per-plan `limits` (sites/domains/databases/nodes/mailboxes) enforced on every create (`403 quota_exceeded`); `GET /billing` exposes plan + usage for quota bars |
| Invoicing engine | ✅ generate a current-period invoice from the org's plan (base fee + usage lines, numbered `INV-YYYY-NNNN`, invoice + line items in one tx); list/detail/pay over `/billing/invoices`; settlement goes through a `PaymentProvider` seam (manual default; a Stripe/Adyen impl plugs in unchanged). Billing UI: usage bars + invoices table + detail modal |
| Reseller hierarchy | ✅ org hierarchy (`parent_org_id`/`is_reseller`); a reseller provisions customer **sub-accounts** — child org + owner user + membership in one transaction, with a one-time temp password and own plan — and can suspend/reactivate them (`/reseller/accounts`). Reseller UI included |
| White-label branding | ✅ per-org `org_branding` (panel name, logo, primary color, support) with **reseller→sub-account inheritance** (own → parent → platform default); `GET/PUT /branding`; the panel applies the brand **live** (theme `--color-primary`, name, title, logo) via a branding provider; settings page with live preview |
| Migration tooling (cPanel/Plesk) | ✅ a normalized account manifest is parsed into a migration plan (`internal/migrate`, unit-tested); `POST /migrations` stores the plan, `POST /migrations/{id}/import` **really imports domains + their DNS** (reusing the domain/DNS vertical) and logs databases/mailboxes as manual steps (their data needs source credentials); Migrations UI with plan review + import log |
| Web Panel — full hosting UI (sites, domains/DNS, SSL, databases, email + webmail, FTP, file manager, cron, backups, runtime, one-click apps, metrics, firewall, audit, API tokens, notifications) | 🟡 **all screens implemented** + typed API client; backend endpoints exist for auth/nodes/websites/deployments/**databases**/API-tokens — the remaining sections are UI-ready with backend WIP |
| Node metrics (real) | ✅ agent samples CPU (`/proc/stat`), memory (`/proc/meminfo`), disk (`df`) and load every 15s → pushes to the CP metrics-ingest endpoint → `node_metrics` time series → `GET /metrics` aggregates the fleet (latest per node + CPU sparkline) for the panel (parsers unit-tested; traffic metrics need proxy integration) |
| Container logs | ✅ `GET /sites/{id}/logs` → signed `logs.tail` job → agent `docker logs --tail N --timestamps` on the site's container (name allowlisted to `astp_*`, argv-injection-proof) → live log viewer with site picker, tail size and auto-refresh |
| Health checks & alerting | ✅ signed `health.check` → agent probes container liveness (`docker inspect`) + optional HTTP → status stored per site; a **60s background sweep** re-probes the whole fleet. Transitions open/close **incidents** (`health_incidents`, one open per site) and fire notifications; the Health panel shows live status + an incident timeline (`GET /health`, `/health/incidents`, on-demand check) |
| Antivirus (ClamAV) | ✅ signed `antivirus.scan` → agent runs `clamscan -r` on a **sandboxed** site path (same path-traversal guard as the file manager), parses per-file verdicts → `POST /sites/{id}/files/scan` + a Scan action in the File Manager (clean / infected list; graceful when the engine isn't installed) |
| Observability (OTel/Prom/Grafana/Loki) | ✅ wired in compose; app instrumentation ongoing |

The 🟡 items have their contracts, schema, job types, and tests in place so they extend
without architectural change. See [`docs/roadmap.md`](docs/roadmap.md).

## Editions & licensing (open-core)

AsterPanel is **source-available under [PolyForm Noncommercial 1.0.0](LICENSE)**:
noncommercial use is free; commercial production use requires a license.

The whole source ships in this public repo, but the **commercial layer is gated by
an Ed25519-signed license** — the source is present yet inert without a valid key:

| Edition | What you get |
| --- | --- |
| **Community** (default) | Full core hosting — sites, domains/DNS, SSL, databases, email + webmail, file manager, cron, FTP, metrics/health/logs, firewall, antivirus — **limited to a single node** |
| **Pro / Enterprise** (licensed) | Unlocks the commercial layer: **resellers & sub-accounts, white-label branding, the invoicing engine, migration tooling, and multi-node** |

How it works:

- The control plane verifies a license with `ASTERPANEL_LICENSE_PUBKEY` (your public
  key) and `ASTERPANEL_LICENSE` (the issued token). No/invalid/expired license →
  Community (it **fails closed to free**, never crashes). See
  [`control-plane/internal/licensing`](control-plane/internal/licensing).
- Gated routes return `402 license_required`; `GET /api/v1/license` reports the active
  edition + features so the UI can show locked state.
- Mint licenses offline with the vendor tool (the private key stays with you):

  ```sh
  go run ./control-plane/cmd/license-gen keygen          # one-time keypair
  go run ./control-plane/cmd/license-gen sign -key <privB64> \
        -to "Customer" -features reseller,white_label,billing,migration,multi_node \
        -max-nodes 10 -days 365
  ```

### Build hardening (deterrent)

Source obfuscation is **not** the protection — the lock is the license above.
Shipped *artifacts* are nonetheless hardened as a deterrent:

- **Control plane (Go)** — built `-trimpath -ldflags "-s -w"` (no symbol table,
  no DWARF, no source paths).
- **Node agent (Rust)** — release profile `strip = true`, `lto = "thin"`,
  `codegen-units = 1`.
- **Web (Next.js)** — production bundle minified, no browser source maps, no
  `X-Powered-By` header, `console.*` stripped (errors/warnings kept).

## Roadmap

Phase 2 highlights: containerd/Kubernetes executor, HA Control Plane, billing & metering,
marketplace one-click apps, DNS provider integrations, WAF, multi-region, SSO/SCIM. Full
plan in [`docs/roadmap.md`](docs/roadmap.md).

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
