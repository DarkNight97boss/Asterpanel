#!/usr/bin/env bash
# AsterPanel node agent installer + enroller.
#
# Performs the real bootstrap: generate a keypair + CSR, exchange the one-time
# enrollment token for a CA-signed mTLS certificate, pin the control plane's
# Ed25519 job-signing public key, then start the agent.
#
# Required env:
#   AGENT_ENROLLMENT_TOKEN   one-time token from the panel (Nodes → Enroll)
#   CONTROL_PLANE_URL        e.g. https://panel.example.com
# Optional:
#   AGENT_NODE_ID  INSTALL_DIR(/etc/asterpanel)  AGENT_IMAGE
set -euo pipefail

: "${AGENT_ENROLLMENT_TOKEN:?set AGENT_ENROLLMENT_TOKEN}"
: "${CONTROL_PLANE_URL:?set CONTROL_PLANE_URL}"
INSTALL_DIR="${INSTALL_DIR:-/etc/asterpanel}"
AGENT_IMAGE="${AGENT_IMAGE:-ghcr.io/darknight97boss/asterpanel-agent:latest}"
SECRETS="$INSTALL_DIR/secrets"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }
need openssl; need curl; need docker; need python3

json_str() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }
json_get() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }

mkdir -p "$SECRETS/agent" "$SECRETS/ca" "$SECRETS/job-signing"

echo "→ generating keypair + CSR"
HOST_FQDN="$(hostname -f 2>/dev/null || hostname)"
openssl ecparam -name prime256v1 -genkey -noout -out "$SECRETS/agent/agent.key"
openssl req -new -key "$SECRETS/agent/agent.key" \
  -subj "/O=AsterPanel/CN=${AGENT_NODE_ID:-$HOST_FQDN}" \
  -addext "subjectAltName=DNS:${HOST_FQDN},DNS:localhost" \
  -out "$SECRETS/agent/agent.csr"

echo "→ exchanging enrollment token for a certificate"
REQ=$(printf '{"enrollment_token":%s,"csr_pem":%s}' \
  "$(printf '%s' "$AGENT_ENROLLMENT_TOKEN" | json_str)" \
  "$(cat "$SECRETS/agent/agent.csr" | json_str)")
RESP=$(curl -fsSL -X POST "$CONTROL_PLANE_URL/api/v1/agents/enroll" \
  -H 'Content-Type: application/json' -d "$REQ")

printf '%s' "$RESP" | json_get certificate    > "$SECRETS/agent/agent.crt"
printf '%s' "$RESP" | json_get ca_certificate > "$SECRETS/ca/ca.crt"
NODE_ID=$(printf '%s' "$RESP" | json_get node_id)

echo "→ pinning control-plane job-signing public key"
curl -fsSL "$CONTROL_PLANE_URL/.well-known/asterpanel/job-signing-key" \
  -o "$SECRETS/job-signing/ed25519.pub"

chmod -R go-rwx "$SECRETS" 2>/dev/null || true
echo "✓ enrolled node $NODE_ID"

echo "→ starting agent"
docker rm -f asterpanel-agent >/dev/null 2>&1 || true
docker run -d --name asterpanel-agent --restart unless-stopped \
  -p 7443:7443 \
  -e AGENT_NODE_ID="$NODE_ID" \
  -e AGENT_LISTEN_ADDR=0.0.0.0:7443 \
  -e AGENT_TLS_CERT_PATH=/secrets/agent/agent.crt \
  -e AGENT_TLS_KEY_PATH=/secrets/agent/agent.key \
  -e AGENT_CA_CERT_PATH=/secrets/ca/ca.crt \
  -e AGENT_TRUSTED_JOB_PUBKEY_PATH=/secrets/job-signing/ed25519.pub \
  -e AGENT_CONTROL_PLANE_CALLBACK_URL="$CONTROL_PLANE_URL" \
  -v "$SECRETS:/secrets:ro" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$AGENT_IMAGE"

echo "✓ agent running on :7443 (node $NODE_ID)"
