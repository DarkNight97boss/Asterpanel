import { baseUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

/** Installer for a node: `curl … | sudo ASTER_TOKEN=… ASTER_PUBLIC_KEY=… bash`. */
export async function GET() {
  const origin = await baseUrl();
  const script = `#!/usr/bin/env bash
set -euo pipefail

: "\${ASTER_TOKEN:?Set ASTER_TOKEN (shown once when the node is created)}"
: "\${ASTER_PUBLIC_KEY:?Set ASTER_PUBLIC_KEY}"
ASTER_URL="\${ASTER_URL:-${origin}}"

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/engine/install/" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required (apt install git)." >&2; exit 1; }
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20+ is required: https://nodejs.org/en/download" >&2; exit 1; }

install -d -m 700 /var/lib/aster-agent
install -d /opt/aster-agent
curl -fsSL "$ASTER_URL/agent/aster-agent.mjs" -o /opt/aster-agent/aster-agent.mjs

umask 077
cat > /etc/aster-agent.env <<ENV
ASTER_URL=$ASTER_URL
ASTER_TOKEN=$ASTER_TOKEN
ASTER_PUBLIC_KEY=$ASTER_PUBLIC_KEY
ASTER_DRIVER=docker
ASTER_DATA_DIR=/var/lib/aster-agent
ASTER_ACME_EMAIL=\${ASTER_ACME_EMAIL:-}
ENV

cat > /etc/systemd/system/aster-agent.service <<UNIT
[Unit]
Description=Aster node agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
EnvironmentFile=/etc/aster-agent.env
ExecStart=$(command -v node) /opt/aster-agent/aster-agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now aster-agent
echo "aster-agent installed. Logs: journalctl -u aster-agent -f"
`;
  return new Response(script, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" } });
}
