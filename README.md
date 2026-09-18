# AsterPanel

A universal CMS for hosting providers: a fully customisable **website**, a **client area** and a WHMCS-style **billing & automation panel** in a single self-hosted application.

> The previous control-plane / node-agent prototype lives on the [`legacy-v1`](../../tree/legacy-v1) branch.

## What's inside

| Area | Path | What it does |
|---|---|---|
| **Website** | `/` | Pages built from blocks (hero, live pricing tables, features, stats, testimonials, FAQ, Markdown, CTA), editable menus, SEO fields, theming (colours, radius, font, light/dark, logo, custom CSS). |
| **Order flow** | `/order/<product>` | Pick a billing cycle and domain → order, service and invoice are created atomically. |
| **Client area** | `/client` | Services, invoices and payment, support tickets, profile and password. |
| **Admin** | `/admin` | Dashboard, clients, orders, services (activate / suspend / unsuspend / terminate), invoices and manual payments, tickets, catalog, servers, site builder, settings, automation and audit log. |
| **Automation** | `POST /api/cron` | Renewal invoices, overdue suspension, termination. Idempotent. |

## Quick start (development)

Requires Node.js ≥ 22 and pnpm. No database to install: without `DATABASE_URL` the app uses an embedded PostgreSQL ([PGlite](https://pglite.dev)) stored in `./.data`.

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000> — a fresh database redirects to the **install wizard**, which creates the admin account and (optionally) starter content. Delete `.data/` to start over.

```bash
pnpm test        # billing engine + utilities (in-memory database)
pnpm typecheck
pnpm lint
```

## Production

```bash
cp .env.example .env      # set APP_SECRET, CRON_SECRET, POSTGRES_PASSWORD
docker compose up -d
```

This starts the app, PostgreSQL 17 and an hourly billing cron. Migrations in `./drizzle` run automatically on boot. Put a TLS-terminating reverse proxy (Caddy, Traefik, nginx) in front and forward `Host` / `X-Forwarded-*`.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | production | PostgreSQL connection string. |
| `APP_SECRET` | production | Key for secrets encrypted at rest. **Never rotate without re-saving servers and gateways.** |
| `CRON_SECRET` | for automation | Bearer token for `/api/cron`. |
| `APP_URL` | optional | Public origin, when the proxy rewrites `Host`. |
| `INSTALL_TOKEN` | optional | Required by the install wizard when set — use it if the instance is reachable before you install. |

## Architecture

Next.js 16 (App Router, Server Components, Server Actions) · TypeScript · Tailwind CSS 4 · Drizzle ORM on PostgreSQL.

```
src/
├── app/
│   ├── (site)/        public website, CMS pages, order flow
│   ├── (auth)/        login, register, install wizard
│   ├── client/        client area
│   ├── admin/         admin panel (+ actions.ts: every admin mutation)
│   └── api/           cron, health, payment webhooks
├── cms/               block registry, renderer, editor, safe Markdown
├── modules/
│   ├── provisioning/  ProvisioningModule contract · manual · cPanel & WHM
│   └── gateways/      PaymentGateway contract · Stripe Checkout · bank transfer
├── lib/               billing engine, auth, settings, crypto, formatting
├── i18n/              gettext-style translations (en source, it)
└── db/                schema + connection (postgres.js or PGlite)
drizzle/               SQL migrations (pnpm db:generate)
tests/
```

### Billing engine (`src/lib/billing.ts`)

- Money is integer minor units everywhere; tax is stored per invoice in basis points.
- `placeOrder` creates order + pending service + invoice in one transaction.
- `recordPayment` is the **only** way an invoice becomes paid. It locks the invoice row, is idempotent per `(gateway, externalId)` (webhooks are at-least-once), supports partial payments, then fulfils: new services are provisioned, renewals advance `nextDueDate`, overdue suspensions are lifted.
- `runAutomation` issues one renewal invoice per client, suspends after the grace period, optionally terminates. A failed provisioning call never un-pays an invoice: the service stays `pending` for a retry from the admin.

### Extending

**Provisioning module** — implement `ProvisioningModule` (`create / suspend / unsuspend / terminate`, all idempotent; optional `testConnection`, `loginUrl`), declare its `serverFields` and `productFields`, register it in `src/modules/provisioning/index.ts`. The admin forms are generated from those field definitions.

**Payment gateway** — implement `PaymentGateway.start()` returning a redirect or offline instructions, add a webhook route under `src/app/api/webhooks/` that verifies the signature and calls `recordPayment`.

**Page block** — add a definition to `src/cms/blocks.ts` and a renderer case in `src/cms/render.tsx`. The editor form, validation and sanitising come from the definition; no migration needed.

**Language** — copy `src/i18n/locales/it.ts`, translate, register it in `src/i18n/shared.ts` and in the `locale` enum of `src/lib/settings.ts`.

### Security

- Passwords: scrypt (N=2¹⁵) with per-hash salt; login is rate-limited and timing-equalised.
- Sessions: random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie; only its SHA-256 is stored. Changing password or suspending an account revokes sessions.
- Server credentials and gateway keys: AES-256-GCM at rest, never sent back to the browser.
- Every mutation is a Server Action that re-checks role (`requireStaff` / `requireAdmin`) and, in the client area, ownership of the record.
- CMS content is rendered as React elements (no raw HTML); links are scheme-checked; editor output is sanitised against the block registry.
- Stripe webhooks are signature-verified with a 5-minute tolerance.
- Admin mutations and lifecycle events are written to an audit log.

## Roadmap

Domain registrar modules · more provisioning modules (Plesk, Proxmox, DirectAdmin) · PayPal · email notifications and templates · PDF invoices & e-invoicing (SDI) · coupons, product add-ons and upgrades · 2FA / passkeys · REST API and webhooks · media library.
