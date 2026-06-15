# AsterPanel — Architecture

This document describes the system design: components, trust boundaries, the data model, and
the core control flows.

## 1. Design tenets

1. **Control plane / data plane separation.** The Control Plane orchestrates; it never runs
   tenant workloads and never executes shell commands on hosting nodes. The Node Agent is the
   only component with host privileges, and it only acts on validated, signed jobs.
2. **Capability over ambient authority.** Each job is a narrowly-scoped, signed capability with
   a short TTL. Possessing the Control Plane API does not grant host access — only a correctly
   signed, policy-approved, non-replayed, unexpired job does.
3. **Everything is authorized and audited.** Every API call passes auth + RBAC + (for sensitive
   actions) OPA. Every state change appends to a hash-chained audit log.
4. **Idempotency.** Every executor is idempotent and keyed by job id, so retries and at-least-once
   delivery are safe.
5. **Pluggable runtime.** The Agent's `Executor` is an interface. Docker is the first backend;
   containerd/Kubernetes implement the same contract.

## 2. Components

### 2.1 Web Panel (`web/`) — Next.js 15 / TS / Tailwind / shadcn/ui
Server components for data fetching, a typed API client, cookie-based session with CSRF tokens
for browser flows. No business logic — it is a presentation layer over the Control Plane API.

### 2.2 API Gateway — Caddy (or Traefik)
TLS termination, HTTP/3, security headers, rate-limit edge, routes `/api/*` to the Control
Plane and `/` to the Web Panel. Config is generated dynamically as sites are created
(`deploy/caddy/`).

### 2.3 Control Plane (`control-plane/`) — Go
Stateless REST API. Responsibilities:
- **AuthN**: password (Argon2id), TOTP, WebAuthn, OIDC; JWT access tokens + rotating refresh tokens; sessions; scoped API tokens.
- **AuthZ**: RBAC (roles → permissions) + OPA policy decisions for sensitive operations.
- **Domain logic**: nodes, domains, DNS, websites, apps, deployments, env/secrets, backups.
- **Job orchestration**: builds, signs (Ed25519), and dispatches jobs to Agents over mTLS; tracks status.
- **Audit**: append-only, hash-chained log of every privileged action.
- **Events**: publishes to NATS (notifications, metrics ingestion, async fan-out).

It holds the **job-signing private key** and a **client certificate** for mTLS to agents. It
does **not** hold host root anywhere.

### 2.4 Node Agent (`node-agent/`) — Rust
Runs on every hosting server. Responsibilities:
- Terminate **mTLS** (server side); accept jobs only from the Control Plane client cert.
- **Verify** the Ed25519 job signature against the pinned Control-Plane public key.
- Enforce **nonce anti-replay** + **TTL**; confirm the job targets this node.
- Dispatch to the matching **idempotent executor** (create site, deploy, proxy config, backup…).
- Manage per-tenant **containers** with least privilege (non-root, userns, seccomp/AppArmor, resource + network limits).
- Report status back to the Control Plane over mTLS; expose health + metrics.

### 2.5 Stateful backing services
- **PostgreSQL** — single system of record.
- **Redis** — sessions cache, rate-limit counters, nonce cache hints, ephemeral locks.
- **NATS** — event bus / async job fan-out / notifications.
- **OPA** — policy decision point.
- **Vault / SOPS** — secret sealing (envelope keys for the `secrets` table).
- **OpenTelemetry + Prometheus + Grafana + Loki** — traces, metrics, dashboards, logs.

## 3. Trust boundaries

```
 ┌─ Boundary A: Internet ───────────────────────────────────────────┐
 │  Browser ── HTTPS ──▶ API Gateway (Caddy)                         │
 └──────────────────────────────────┬───────────────────────────────┘
                                     │ (internal network, authn JWT/session)
 ┌─ Boundary B: Control plane ───────▼───────────────────────────────┐
 │  Control Plane (Go) ── Postgres / Redis / NATS / OPA / Vault      │
 │  Holds: job-signing private key, mTLS client cert, secret master  │
 └──────────────────────────────────┬───────────────────────────────┘
                                     │ Boundary C: mTLS + Ed25519-signed jobs
 ┌─ Boundary D: Data plane (per node)▼───────────────────────────────┐
 │  Node Agent (Rust) ── Docker ── per-tenant containers (isolated)  │
 │  Holds: agent mTLS cert, pinned CP public key                     │
 └───────────────────────────────────────────────────────────────────┘
```

Crossing **C** requires *both* a valid mTLS client certificate *and* a valid job signature —
defense in depth. Compromise of the Control Plane network does not by itself yield host code
execution without the signing key; compromise of the signing key without network access cannot
reach agents; replaying a captured job fails on nonce/TTL.

## 4. Data model

System of record is PostgreSQL. Entities and key relationships:

```
organizations 1───* memberships *───1 users
users 1───* sessions
users 1───* webauthn_credentials
users 1───* totp_secrets
organizations 1───* api_tokens
organizations 1───* roles 1───* role_permissions *───1 permissions
memberships *───1 roles

organizations 1───* server_nodes 1───* agent_registrations
server_nodes 1───* node_metrics

organizations 1───* domains 1───* dns_zones 1───* dns_records
organizations 1───* websites 1───* applications
applications 1───* deployments 1───* deployment_logs
applications 1───* environment_variables
applications 1───* secrets
applications 1───* database_instances
applications 1───* health_checks

websites/applications 1───* backups 1───* restore_jobs

organizations 1───* audit_logs        (append-only, hash-chained)
users 1───* notifications
organizations *───1 billing_plans      (optional)
jobs: every dispatched job is persisted with status + signature metadata
```

Full column definitions: [`db/migrations/0001_init.up.sql`](../db/migrations/0001_init.up.sql).
Design choices:
- **Random UUIDv4** primary keys (`gen_random_uuid()`) as external ids — non-sequential and
  non-enumerable; high-volume time series (`*_metrics`, `*_logs`, `audit_logs`) use `bigserial`.
- **Tenant scoping**: nearly every row carries `organization_id`; queries are tenant-filtered and
  (phase 2) enforced by Postgres Row-Level Security.
- **Soft delete** via `deleted_at` on user-facing resources; hard delete only via GC jobs.
- **Audit immutability**: `audit_logs` is append-only (no `UPDATE`/`DELETE` grants; trigger-guarded),
  each row chaining `prev_hash → hash`.

## 5. Core flows

### 5.1 Login (password + second factor)
```
Browser → POST /api/v1/auth/login {email,password}
  CP: lookup user, Argon2id verify, check status
  CP: if 2FA enabled → respond 200 {mfa_required, methods:[totp,webauthn], mfa_token}
Browser → POST /api/v1/auth/mfa/verify {mfa_token, totp|assertion}
  CP: verify factor → create session, issue access JWT (10m) + refresh token (rotating)
  CP: set HttpOnly refresh cookie + CSRF cookie; audit "auth.login"
```

### 5.2 Refresh-token rotation with reuse detection
```
Browser → POST /api/v1/auth/refresh  (refresh cookie)
  CP: hash token, look up; if not found or already-rotated → REUSE DETECTED:
      revoke entire token family + session, audit "auth.refresh.reuse", 401
  CP: else mark current rotated, issue new refresh (same family), new access JWT
```

### 5.3 Create website (signed-job dispatch)
```
Browser → POST /api/v1/websites {domain,node_id,runtime,...}
  CP: authn → RBAC(website.create) → OPA(input) → validate
  CP: persist website (state=provisioning); build Job{type:website.create,...}
  CP: sign(Ed25519), store job, audit "website.create"
  CP → Agent (mTLS) POST /v1/jobs  [X-Asterpanel-Signature]
  Agent: verify cert + sig + nonce + ttl + node_id → executor.website_create() (idempotent)
  Agent: provisions container + proxy route + cert; returns 202 accepted
  Agent → CP (mTLS) POST /v1/agents/{id}/jobs/{jobId}/status {succeeded, result}
  CP: website.state=active; NATS publish "website.created"; audit "job.completed"
```

### 5.4 Deploy from Git with rollback
```
Browser → POST /api/v1/applications/{id}/deployments {ref}
  CP: authz/audit; create deployment(record N, state=queued)
  CP → Agent signed Job{type:app.deploy, payload:{git_url, ref, build, prev_image}}
  Agent: fetch → build image (tagged by deployment id) → start new container →
         health-check → atomically swap proxy upstream → keep prev container/image
  on success: deployment.state=active; previous marked superseded (retained for rollback)
  on failure: executor leaves previous serving; deployment.state=failed
Rollback: POST /api/v1/applications/{id}/rollback {to_deployment}
  CP → Agent Job{type:app.rollback} → swap upstream back to retained image
```

Every executor is keyed by `job.id` and checks current host state before acting, so a retried
or duplicated job is a no-op if already applied.

## 6. Scaling & HA (target)

- Control Plane is stateless → run N replicas behind the gateway; Postgres is the only hard
  dependency for consistency, Redis/NATS are clustered.
- Agents are independent; losing one only affects its node's tenants.
- Phase 2 introduces a leader-elected reconciler that drives desired vs. observed node state
  (Kubernetes-style control loop) instead of pure imperative dispatch.

## 7. Technology choices & rationale

| Concern | Choice | Why |
|---|---|---|
| Control Plane | Go | Strong stdlib for servers/crypto/TLS, fast, easy static binaries, great concurrency for fan-out. |
| Node Agent | Rust | Memory safety on the privileged host component; `rustls` mTLS, `ed25519-dalek`, `bollard` Docker API. |
| DB | PostgreSQL | Transactions, RLS, JSONB, mature tooling. |
| Bus | NATS | Lightweight, fast, JetStream for durable streams. |
| Policy | OPA | Decouples authorization from code; testable Rego. |
| Proxy | Caddy/Traefik | Automatic ACME TLS, dynamic config, HTTP/3. |
| Frontend | Next.js 15 | RSC data fetching, mature ecosystem, shadcn/ui. |
