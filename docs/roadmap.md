# AsterPanel — Roadmap

## Phase 1 — MVP foundation (this repository)

Goal: a real, buildable, secure core with the control/data-plane split fully wired.

- [x] Monorepo, Docker Compose dev env, Makefile, CI/CD.
- [x] PostgreSQL schema + migrations + seed; append-only audit log.
- [x] Control Plane: config, structured logging, Postgres store, REST API skeleton with
      authn + RBAC + OPA middleware on every route.
- [x] Auth: Argon2id, JWT access tokens, rotating refresh tokens with reuse detection,
      sessions + revocation, TOTP, scoped API tokens; WebAuthn begin/finish endpoints.
- [x] Ed25519 job signing with canonical encoding; signed-job examples + verifier.
- [x] Node Agent: mTLS server, signature/nonce/TTL verification, executor interface,
      Docker executor with hardening, status callback.
- [x] Node enrollment (one-time bootstrap token → CSR → CA-signed cert).
- [x] Reverse-proxy (Caddy/Traefik) dynamic config; provisioning script.
- [x] OpenAPI 3.1 spec + Swagger UI; OPA policy tests; per-language unit tests.
- [x] Per-runtime deploy builders end-to-end: `app.deploy` (git clone → docker build →
      hardened run, prior image kept for rollback) with buildpack auto-detection
      (Node/PHP/static) synthesizing a Dockerfile when the repo lacks one.
- [x] Backups/restore/rollback executors end-to-end: `backup.create`/`backup.restore`
      (tar, off-site S3 upload, SHA-256 checksum, completion callback) + recurring schedules.
- [x] Web Panel: every screen wired to the typed API client (hosting + commercial layer).

## Phase 2 — Hardening & scale

- **Runtime**: containerd + Kubernetes executor behind the existing `Executor` trait; pod
  security standards, network policies, gVisor/Kata option for stronger isolation.
- **HA Control Plane**: multiple replicas, leader-elected reconciler (desired/observed loop),
  Postgres HA, NATS JetStream durable streams.
- **Authz**: Postgres Row-Level Security, ABAC attributes in OPA, SSO (OIDC) + SCIM provisioning.
- **Secrets**: full Vault transit/transit-engine integration, automatic envelope-key rotation,
  optional HSM/KMS-backed job-signing key.
- **Supply chain**: cosign/sigstore image signing, SLSA provenance, SBOM per deployment, CRL/OCSP
  for agent certs, short-lived rotating agent certificates.
- **Networking**: per-tenant WAF, egress policies, IPv6, private networking between apps.
- **DNS**: provider integrations (Cloudflare, Route53, PowerDNS) behind a `DnsProvider` interface.
- **Observability**: full OTel instrumentation, SLOs, alerting, per-tenant usage dashboards.

## Phase 3 — Product

- Billing & metering (usage → invoices), plan enforcement, quotas.
- App marketplace / one-click installs with signed recipes.
- Multi-region orchestration, geo-failover, managed databases as a first-class resource.
- Team collaboration, granular delegated admin, customer-facing API & webhooks.
- Migration tooling from cPanel/Plesk.

## Non-goals (for now)

- Being a drop-in cPanel UI clone — the model is intentionally different.
- Running the Control Plane on the same host as tenant workloads.
- Direct shell access as a feature — all host actions go through typed, signed jobs.
