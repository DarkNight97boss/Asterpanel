#!/usr/bin/env bash
# Generate development PKI for AsterPanel:
#   - a project CA (EC P-256)
#   - a control-plane mTLS client certificate
#   - a node-agent mTLS server+client certificate
#   - an Ed25519 job-signing keypair (used to sign jobs; verified by the agent)
#
# Idempotent: existing files are kept. NEVER use these dev keys in production.
set -euo pipefail

DIR="${1:-./secrets}"
CA_DIR="$DIR/ca"
mkdir -p "$CA_DIR" "$DIR/control-plane" "$DIR/agent" "$DIR/job-signing"

require_openssl() {
  command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }
}
require_openssl

# --- CA ----------------------------------------------------------------------
if [[ ! -f "$CA_DIR/ca.crt" ]]; then
  echo "→ generating CA"
  openssl ecparam -name prime256v1 -genkey -noout -out "$CA_DIR/ca.key"
  openssl req -x509 -new -key "$CA_DIR/ca.key" -sha256 -days 3650 \
    -subj "/O=AsterPanel/CN=AsterPanel Dev CA" -out "$CA_DIR/ca.crt"
fi

# gen_cert <dir> <name> <CN> <extendedKeyUsage> [subjectAltName]
gen_cert() {
  local dir="$1" name="$2" cn="$3" eku="$4" san="${5:-}"
  [[ -f "$dir/$name.crt" ]] && { echo "→ $name cert exists, skipping"; return; }
  echo "→ generating $name cert"
  openssl ecparam -name prime256v1 -genkey -noout -out "$dir/$name.key"
  openssl req -new -key "$dir/$name.key" -subj "/O=AsterPanel/CN=$cn" -out "$dir/$name.csr"
  {
    echo "keyUsage = critical, digitalSignature, keyEncipherment"
    echo "extendedKeyUsage = $eku"
    [[ -n "$san" ]] && echo "subjectAltName = $san"
  } > "$dir/$name.ext"
  openssl x509 -req -in "$dir/$name.csr" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" \
    -CAcreateserial -sha256 -days 825 -extfile "$dir/$name.ext" -out "$dir/$name.crt"
  rm -f "$dir/$name.csr" "$dir/$name.ext"
}

# Control plane: client auth only (it dials agents).
gen_cert "$DIR/control-plane" "client" "asterpanel-control-plane" "clientAuth"

# Agent: server (accepts jobs) + client (calls back). SANs cover compose + local.
gen_cert "$DIR/agent" "agent" "asterpanel-agent" "serverAuth,clientAuth" \
  "DNS:node-agent,DNS:localhost,IP:127.0.0.1"

# --- Ed25519 job-signing key -------------------------------------------------
if [[ ! -f "$DIR/job-signing/ed25519.key" ]]; then
  echo "→ generating Ed25519 job-signing key"
  openssl genpkey -algorithm ed25519 -out "$DIR/job-signing/ed25519.key"
  openssl pkey -in "$DIR/job-signing/ed25519.key" -pubout -out "$DIR/job-signing/ed25519.pub"
fi

chmod -R go-rwx "$DIR" 2>/dev/null || true
echo "✓ secrets ready in $DIR"
