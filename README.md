# AsterPanel

A managed-hosting platform you run on your own servers: a MyKinsta-style dashboard for your customers, the engine that really creates their sites in isolated containers, and the business side (plans, invoices, payments, support, a fully editable website) built in. One self-hosted application plus a small agent per server.

> The first control-plane / node-agent prototype lives on the [`legacy-v1`](../../tree/legacy-v1) branch.

## What customers get

| | |
|---|---|
| **Managed WordPress** | One site per isolated container stack, free hostname + custom domains with automatic SSL, one-click **staging** (create · push to live · delete), manual and **daily automatic backups** (14 kept) with one-click restore, PHP version switch, **plugins & themes** inventory with one-click updates, WP-CLI tools (cache, debug, search-replace), edge **redirects** and **IP deny**, **edge page cache** (WordPress-aware nginx sidecar, TTL, exclusions, purge), **static asset acceleration** (long-lived edge cache + compression — node-level, not a global CDN), **bot protection** (bad-bot and AI-crawler blocking, per-IP rate limit, hardened wp-login/xmlrpc), **APM** (request-level: average, p95, errors, slowest and busiest paths from the proxy access log), **file manager**, **SFTP** access (on demand, chrooted to the site, password or SSH keys), **database console** (tables + SQL), resource **analytics**, activity history, logs. |
| **Application hosting** | Deploy any repository with a `Dockerfile`. Manual deploys and **push-to-deploy** webhook, encrypted env vars, build logs, a failed build never replaces the running release. |
| **Managed databases** | MySQL (MariaDB), PostgreSQL, Redis on the customer's private network, with credentials, connection URL and backups. |
| **DNS hosting** | Zones and records (A, AAAA, CNAME, MX, TXT, CAA, SRV) served by CoreDNS on your nodes; every change bumps the serial and re-syncs all name servers. Configure the name-server host names in Admin → DNS; nodes need port 53 UDP/TCP free (on Ubuntu, disable the systemd-resolved stub listener). |
| **Static sites** | Build from Git in a throw-away Node.js container, served with automatic HTTPS. |
| **Search & notifications** | Global search across services, domains, DNS zones, invoices and tickets; a bell that lists only what still needs action (it has no "read" state: items vanish when handled). |
| **Account & team** | Plans, invoices (PDF) and payments, support tickets, profile, password reset. **Team members** by email invitation with roles (administrator · developer · billing) and an account switcher for people who work on several accounts. |

## What you get (staff)

Operations dashboard (nodes online, workloads in error, failed jobs, "paid but not provisioned"), **nodes** with live load and one-line install, every **workload**, the **job** queue with full logs, clients, orders, invoices, tickets, catalog, email templates and log, automation, audit log — and a block-based **website** (hero, services, split panels, live pricing, stats, FAQ…) with theming, so the public site matches the dashboard.

## Architecture

```
 Browser ──► Next.js app (control plane) ──► PostgreSQL
                 ▲        │ signed jobs (Ed25519)
   outbound only │        ▼
             aster-agent on each node ──► Docker: one stack per workload
                                          └─ Traefik: routing + Let's Encrypt
```

- **Desired state lives in the database.** Every change (create, new domain, backup, deploy…) becomes a **job** with a log and an outcome. Jobs of one workload never run in parallel; a dead agent's job times out.
- **Agents only make outbound HTTPS calls** (`/api/agent/v1/poll`, `/jobs/:id`) — no open port on your servers. Each node has its own bearer token (stored hashed).
- **Jobs are signed.** The agent pins the control plane's Ed25519 public key at install time and refuses anything unsigned, tampered, expired, replayed or addressed to another node. A stolen node token cannot make a node run arbitrary work. Job payloads and workload secrets are AES-256-GCM encrypted at rest.
- **Isolation.** Per workload: own containers, volumes and network, memory / CPU / PID limits. A customer's apps and databases share a private *tenant* network; customers never share one. User build commands run in a resource-limited container without the Docker socket. The agent spawns commands with argv arrays (never a shell); inside containers, inputs travel as environment variables.
- **Accounts, not users, own things.** Services, invoices and tickets belong to an account; the signed-in user acts in an *active account* (their own or one they were invited to) and every query is scoped by it. The account cookie is only a preference — membership and role are re-checked on each request.
- **Database console and SFTP go through the agent too.** SQL travels over stdin to the engine's own client inside the container (no shell, no argv), is limited to 30 s / 200 rows, needs an explicit confirmation when it is not read-only, and every statement is audited. SFTP is a small OpenSSH container chrooted to the site's files volume, on its own port, with no network of its own.
- **Billing is a module.** A plan is a product with `module: platform` (type, RAM, CPU, disk). Paid invoice → workload created; overdue → suspended (containers stopped); terminated → deleted. cPanel/WHM and "manual" modules still exist for legacy offers.

```
agent/                 node agent (TypeScript, zero runtime deps, bundled to one file)
  src/docker.ts        production driver
  src/simulated.ts     fake driver for development and tests
src/platform/          protocol (shared with the agent), engine, access control
src/app/client/        customer dashboard        src/app/admin/   staff backoffice
src/app/(site)/        public website            src/cms/         blocks, editor, renderer
src/lib/               billing, email, PDF, auth, settings, crypto
src/modules/           provisioning modules and payment gateways
```

## Quick start (development)

Node.js ≥ 22 and pnpm. No database or Docker needed: PGlite is embedded and the agent has a simulated driver.

```bash
pnpm install
pnpm dev                      # http://localhost:3000 → install wizard
```

Then in **Admin → Nodes** add a node and start a local agent with the credentials shown:

```bash
pnpm agent:build
ASTER_URL=http://localhost:3000 ASTER_TOKEN=… ASTER_PUBLIC_KEY=… \
ASTER_DRIVER=simulated ASTER_DATA_DIR=.data/agent node public/agent/aster-agent.mjs
```

```bash
pnpm test        # billing, email, PDF, password reset, platform engine ⇄ agent
pnpm typecheck && pnpm lint
```

## Production

**Control plane**

```bash
cp .env.example .env      # APP_SECRET, CRON_SECRET, POSTGRES_PASSWORD, APP_URL
docker compose up -d
```

**Each node** (Linux, Docker, git, Node.js 20+; ports 80/443 open; wildcard DNS `*.<base domain>` → the server). Create the node in Admin → Nodes and run the command it shows:

```bash
curl -fsSL https://panel.example.com/agent/install.sh | sudo ASTER_TOKEN='…' ASTER_PUBLIC_KEY='…' ASTER_ACME_EMAIL='ops@example.com' bash
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. |
| `APP_SECRET` | Key for everything encrypted at rest. **Never rotate without a migration plan.** |
| `CRON_SECRET` | Bearer token for `POST /api/cron` (renewals, reminders, suspensions, daily backups). |
| `APP_URL` | Public origin — used in emails, webhooks and the agent install command. |
| `INSTALL_TOKEN` | Optional: required by the install wizard when set. |

## Status

Verified here: the whole control plane, the protocol and the agent core, end-to-end with the **simulated** driver (automated tests + manual runs). The **Docker driver is written but has not yet been run on a real Linux node** — expect a round of fixes on first contact with real containers.

## Roadmap

Off-site (S3) backup storage · visitor analytics · code-level (PHP) tracing · a real multi-region CDN · SSH/SFTP access · database external access · CDN · file uploads in the file manager · per-site roles · buildpacks for apps without a Dockerfile · node draining and workload migration · REST API · 2FA · domain registrar modules · e-invoicing (SDI).
