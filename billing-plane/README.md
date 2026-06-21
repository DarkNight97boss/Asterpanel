# Aster Billing

A **standalone billing & automation product** — a modern WHMCS alternative — that
manages clients, products, orders, invoices, dunning and support tickets, and
**provisions hosting on one or more control panels through a pluggable module**.

It is a **separate service** from the AsterPanel hosting control plane. The two
products communicate only over an API:

```
   ┌─────────────────────────┐         ┌──────────────────────────────┐
   │  Aster Billing           │  HTTP   │  Hosting control panel       │
   │  (this service)          │ ──────► │  • AsterPanel  (built in)    │
   │  clients · products ·    │  token  │  • cPanel/WHM  (future)      │
   │  orders · invoices ·     │  auth   │  • Plesk       (future)      │
   │  dunning · tickets       │ ◄────── │                              │
   └─────────────────────────┘ webhooks └──────────────────────────────┘
```

## The two seams

The billing product is **agnostic to two things**, so it is a true platform and
not an add-on:

- **Payment gateway** — `PaymentProvider` (offline/manual by default; Stripe,
  PayPal, … are pluggable modules). *Lives on the billing side.*
- **Hosting backend** — `hosting.Backend` (this package). The billing panel
  never calls AsterPanel's internals; it calls `CreateAccount`, `SuspendAccount`,
  `UnsuspendAccount`, `ChangePackage` on the interface. AsterPanel is one module
  (`internal/hosting/asterpanel.go`); cPanel/Plesk modules implement the same
  interface against their own APIs.

## Status

This service currently ships the **hosting seam**: the `hosting.Backend`
interface, a `Registry`, and a working, unit-tested **AsterPanel module** that
drives the control plane over its token-authenticated REST API. The billing
domain (clients, invoices, dunning, tickets — currently still inside the hosting
control plane) is being re-homed here behind this boundary.

## Run

```sh
BILLING_HOSTING_BASE_URL=https://panel.example.com \
BILLING_HOSTING_API_TOKEN=astp_… \
go run ./cmd/billing
# GET /healthz  -> ok
# GET /readyz   -> {"service":"aster-billing","hosting_backends":["asterpanel"], …}
```
