# Examples — the signed-job protocol

These examples show, end to end, how the control plane signs a job and how an
agent verifies it. The signature covers the **exact transmitted bytes**, so the
Rust agent verifies byte-for-byte — no cross-language canonicalization needed.

## 1. Generate keys

```bash
make secrets   # writes secrets/job-signing/{ed25519.key,ed25519.pub} (+ mTLS certs)
```

## 2. Build & sign a job (uses the real control-plane code)

```bash
cd control-plane
go run ./cmd/signjob --key ../secrets/job-signing/ed25519.key
```

Output:

- the **canonical JSON body** (sorted keys, minimal whitespace) that is signed and sent verbatim,
- the **Ed25519 signature** (base64),
- a ready-to-run **mTLS `curl`** that POSTs it to a running agent at `https://localhost:7443/v1/jobs`.

## 3. What the agent checks (in order)

1. **mTLS** — the client certificate must chain to the project CA (only the control plane has one).
2. **Signature** — `ed25519.verify(pinned_pubkey, body, sig)` over the raw body.
3. **Node match** — `node_id` equals this agent's node (skipped only if `AGENT_ALLOW_ANY_NODE=true`).
4. **Freshness** — `now <= expires_at` and `issued_at` is not implausibly in the future.
5. **Anti-replay** — the `nonce` has not been seen within the retention window.

Any failure → the job is rejected before any executor runs. On success the agent
returns `202 Accepted`, executes the matching idempotent executor, and reports the
outcome back to the control plane.

## 4. Verify a signature manually

```bash
# Re-verify the body+signature you produced above:
python3 - <<'PY'
import base64, subprocess
# (illustrative) — production verification happens in node-agent/src/verify.rs
print("verify in Rust: cargo test -p asterpanel-node-agent verify")
PY
```

The authoritative verifier is [`node-agent/src/verify.rs`](../node-agent/src/verify.rs);
run its unit test with `cd node-agent && cargo test`.
