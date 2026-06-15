# AsterPanel — Threat Model (initial)

Methodology: STRIDE per trust boundary (see `architecture.md` §3), plus an assets/actors list and
an abuse-case review of the highest-risk flows (job dispatch, enrollment, auth).

## 1. Assets

| Asset | Sensitivity | Where |
|---|---|---|
| Job-signing Ed25519 private key | **Critical** — signs host commands | Control Plane only |
| mTLS CA key | **Critical** — mints agent identities | Control Plane (offline-able) |
| Secrets master key (envelope) | **Critical** — decrypts tenant secrets | Control Plane / Vault |
| Tenant secrets & env vars | High | `secrets` (encrypted), `environment_variables` |
| User credentials | High | `users` (Argon2id), `totp_secrets`, `webauthn_credentials` |
| Audit log | High (integrity) | `audit_logs` (append-only, hash-chained) |
| Tenant source/data in containers | High | Node hosts |
| Session/refresh tokens | High | Cookies (HttpOnly), Redis/Postgres (hashed) |

## 2. Actors / threat agents

- External unauthenticated attacker (internet).
- Malicious or compromised tenant (authenticated, low privilege).
- Compromised Web Panel / browser (XSS, token theft).
- Compromised Control Plane network position (can reach agents at L4).
- Malicious node operator / stolen agent host.
- Insider with partial Control Plane access.

## 3. STRIDE by boundary

### Boundary A — Internet ↔ Gateway
| Threat | Vector | Mitigation |
|---|---|---|
| **S**poofing | Credential stuffing, session fixation | Argon2id, mandatory 2FA option, WebAuthn, rate limiting, rotating refresh + reuse detection, HttpOnly+Secure+SameSite cookies, CSRF tokens. |
| **T**ampering | Request tampering, parameter injection | Strict input validation/allowlists, TLS, output encoding, parameterized SQL (pgx). |
| **R**epudiation | "I didn't do that" | Append-only hash-chained audit log keyed to actor + session + request id. |
| **I**nfo disclosure | Verbose errors, header leakage | Generic error envelopes, security headers, no secrets in logs, strict CORS. |
| **D**oS | Flood, expensive endpoints | Edge + app rate limiting (Redis token bucket), request size limits, timeouts, pagination. |
| **E**oP | Authz bypass | Every endpoint behind authn + RBAC + OPA; deny-by-default. |

### Boundary B — Control Plane internals
| Threat | Vector | Mitigation |
|---|---|---|
| **T** | SQL injection | Parameterized queries only; no string-built SQL. |
| **I** | Secret leakage in logs/traces | Central redaction; secrets typed and never `Stringer`-printed; OTel attribute scrubbing. |
| **E** | Tenant crossing | `organization_id` scoping on every query; RLS (phase 2); OPA tenant checks. |
| **R** | Audit tampering | No UPDATE/DELETE grant on `audit_logs`; hash chain verified by a periodic job. |

### Boundary C — Control Plane ↔ Agent (the crown jewels)
| Threat | Vector | Mitigation |
|---|---|---|
| **S** | Fake control plane issuing commands | mTLS: agent only accepts the CP client cert chained to project CA **and** a job signed by the pinned CP Ed25519 key. Two independent secrets required. |
| **S** | Rogue agent impersonation | mTLS client-cert verification on CP callbacks; cert minted only via one-time enrollment. |
| **T** | Job payload tampering in transit | Ed25519 signature over canonical JSON; any change invalidates it. |
| **R**eplay | Capture & resend a valid job | Per-job nonce (rejected if seen) + short TTL (`expires_at`); clock-skew bounded. |
| **E** | Over-broad command | Jobs are typed + schema-validated; executors are narrow; OPA gates dispatch; no shell passthrough. |
| **D** | Job flooding an agent | Agent rate-limits, bounded concurrency, queue caps; CP backpressure. |

### Boundary D — Agent ↔ tenant containers
| Threat | Vector | Mitigation |
|---|---|---|
| **E** | Container escape | Non-privileged containers, user namespaces, dropped capabilities, seccomp + AppArmor profiles, read-only rootfs where possible, no docker.sock in tenant containers. |
| **I** | Cross-tenant snooping | Per-tenant networks, no shared volumes, egress policy. |
| **D** | Noisy neighbor | CPU/memory/PID/IO limits (cgroups) per container. |
| **T** | Poisoned image | Build isolation, pinned base images, image digests recorded per deployment. |

## 4. Key abuse cases & responses

1. **Stolen refresh token** → reuse detection revokes the whole token family + session on the next
   use of either copy; access tokens expire in ≤10 min.
2. **Leaked enrollment token** → single-use + short TTL; using it twice fails; admin can revoke
   un-enrolled nodes; the resulting cert is logged and pin-revocable.
3. **Compromised tenant tries lateral movement** → no host shell; can only call APIs allowed by its
   role; OPA denies cross-tenant ids; network isolation blocks neighbor access.
4. **Signing key compromise** → key id in every job enables fast rotation; agents accept a key set
   so old key can be retired; all jobs are audited for forensic scoping.
5. **Agent host theft** → cert is node-bound and revocable (CRL/short-lived rotation, phase 2);
   secrets are never stored at rest on the node beyond a running container's lifetime.

## 5. Residual risks / explicitly out of scope (MVP)

- Hardware/side-channel attacks on shared hosts.
- Full supply-chain attestation (SLSA) — planned phase 2 (sigstore/cosign image signing).
- HSM-backed signing keys — interface allows it; not wired in MVP.
- DDoS at the network layer — assumed handled upstream (CDN/edge).
- Certificate revocation is rotation-based in MVP; full CRL/OCSP in phase 2.

## 6. Security checklist mapping

The mandatory controls from the project brief and where they live:

| Control | Location |
|---|---|
| mTLS CP↔Agent | `node-agent/src/tls.rs`, `control-plane/internal/agentcomm` |
| Ed25519 job signing | `control-plane/internal/jobs/signer.go`, `node-agent/src/verify.rs` |
| Nonce anti-replay + TTL | `node-agent/src/nonce.rs`, job `expires_at` |
| OPA policy | `policies/`, `control-plane/internal/authz` |
| Rate limiting | `control-plane/internal/middleware/ratelimit.go` |
| CSRF | `control-plane/internal/middleware/csrf.go` |
| Input validation | per-handler validators, `internal/api/validate` |
| Security headers / CORS | `internal/middleware/secure.go`, gateway config |
| Argon2id | `control-plane/internal/crypto/password.go` |
| Refresh rotation / revocation | `control-plane/internal/auth/refresh.go`, `session.go` |
| Append-only audit | `db/migrations` triggers + `internal/audit` |
| Container hardening | `node-agent/src/executor/docker.rs` (security opts) |
| Secrets encryption at rest | `control-plane/internal/crypto/envelope.go`, `secrets` table |
