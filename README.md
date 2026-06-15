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
| Plan quotas & billing | ✅ per-plan `limits` (sites/domains/databases/nodes/mailboxes) enforced on every create (`403 quota_exceeded`); `GET /billing` exposes plan + usage for quota bars |
| Web Panel — full hosting UI (sites, domains/DNS, SSL, databases, email + webmail, FTP, file manager, cron, backups, runtime, one-click apps, metrics, firewall, audit, API tokens, notifications) | 🟡 **all screens implemented** + typed API client; backend endpoints exist for auth/nodes/websites/deployments/**databases**/API-tokens — the remaining sections are UI-ready with backend WIP |
| Node metrics (real) | ✅ agent samples CPU (`/proc/stat`), memory (`/proc/meminfo`), disk (`df`) and load every 15s → pushes to the CP metrics-ingest endpoint → `node_metrics` time series → `GET /metrics` aggregates the fleet (latest per node + CPU sparkline) for the panel (parsers unit-tested; traffic metrics need proxy integration) |
| Container logs | ✅ `GET /sites/{id}/logs` → signed `logs.tail` job → agent `docker logs --tail N --timestamps` on the site's container (name allowlisted to `astp_*`, argv-injection-proof) → live log viewer with site picker, tail size and auto-refresh |
| Observability (OTel/Prom/Grafana/Loki) | ✅ wired in compose; app instrumentation ongoing |

The 🟡 items have their contracts, schema, job types, and tests in place so they extend
without architectural change. See [`docs/roadmap.md`](docs/roadmap.md).

## Roadmap

Phase 2 highlights: containerd/Kubernetes executor, HA Control Plane, billing & metering,
marketplace one-click apps, DNS provider integrations, WAF, multi-region, SSO/SCIM. Full
plan in [`docs/roadmap.md`](docs/roadmap.md).

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
