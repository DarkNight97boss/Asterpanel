import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

// Isolated in-memory database; must be set before the app modules load.
process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

type Billing = typeof import("../src/lib/billing");
type DbModule = typeof import("../src/db");

let billing: Billing;
let dbm: DbModule;
let clientId: string;
let productId: string;

const DAY = 86_400_000;

before(async () => {
  dbm = await import("../src/db");
  billing = await import("../src/lib/billing");
  const { updateSettings } = await import("../src/lib/settings");
  await updateSettings("billing", { taxRate: 2200, currency: "EUR" });

  const db = await dbm.getDb();
  const { users, productGroups, products } = dbm.schema;
  [{ id: clientId }] = await db.insert(users).values({ email: "c@example.test", passwordHash: "x" }).returning();
  const [group] = await db.insert(productGroups).values({ slug: "g", name: "G" }).returning();
  [{ id: productId }] = await db
    .insert(products)
    .values({ groupId: group.id, slug: "p", name: "Plan", pricing: { monthly: 1000, setup: 500 } })
    .returning();
});

test("order → invoice with setup fee and tax, service pending", async () => {
  const db = await dbm.getDb();
  const { invoiceId } = await billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "Example.COM" });
  const invoice = await db.query.invoices.findFirst({ where: eq(dbm.schema.invoices.id, invoiceId), with: { items: true } });
  assert.equal(invoice?.subtotal, 1500);
  assert.equal(invoice?.tax, 330);
  assert.equal(invoice?.total, 1830);
  assert.equal(invoice?.items.length, 2);
  const [service] = await db.select().from(dbm.schema.services);
  assert.equal(service.status, "pending");
  assert.equal(service.domain, "example.com");
});

test("rejects a cycle the product does not sell", async () => {
  await assert.rejects(billing.placeOrder({ clientId, productId, cycle: "annually", domain: "a.com" }), billing.BillingError);
});

test("partial payment keeps the invoice unpaid; full payment activates; webhooks are idempotent", async () => {
  const db = await dbm.getDb();
  const [invoice] = await db.select().from(dbm.schema.invoices);

  assert.deepEqual(await billing.recordPayment({ invoiceId: invoice.id, gateway: "stripe", externalId: "pi_1", amount: 1000 }), { paid: false, duplicate: false });
  assert.deepEqual(await billing.recordPayment({ invoiceId: invoice.id, gateway: "stripe", externalId: "pi_2", amount: 830 }), { paid: true, duplicate: false });
  assert.deepEqual(await billing.recordPayment({ invoiceId: invoice.id, gateway: "stripe", externalId: "pi_2", amount: 830 }), { paid: true, duplicate: true });

  assert.equal((await db.select().from(dbm.schema.transactions)).length, 2);
  const [service] = await db.select().from(dbm.schema.services);
  assert.equal(service.status, "active");
  assert.ok(service.nextDueDate && service.nextDueDate.getTime() > Date.now() + 27 * DAY);
});

test("automation: invoices a renewal once, suspends when overdue, payment restores and advances the due date", async () => {
  const db = await dbm.getDb();
  const { services, invoices } = dbm.schema;
  const [service] = await db.select().from(services);
  const due = service.nextDueDate!;

  // 10 days before due → inside the 14-day invoicing window.
  const first = await billing.runAutomation(new Date(due.getTime() - 10 * DAY));
  assert.equal(first.invoiced, 1);
  const again = await billing.runAutomation(new Date(due.getTime() - 9 * DAY));
  assert.equal(again.invoiced, 0, "second run must not invoice twice");

  // 6 days after due → past the 5-day grace period.
  const late = await billing.runAutomation(new Date(due.getTime() + 6 * DAY));
  assert.equal(late.suspended, 1);
  assert.equal((await db.select().from(services))[0].status, "suspended");

  const renewal = (await db.select().from(invoices)).find((i) => i.status === "unpaid")!;
  assert.equal(renewal.total, 1220, "renewal has no setup fee");
  await billing.recordPayment({ invoiceId: renewal.id, gateway: "manual", externalId: "", amount: renewal.total });

  const [restored] = await db.select().from(services);
  assert.equal(restored.status, "active");
  assert.ok(restored.nextDueDate!.getTime() > due.getTime() + 27 * DAY);
});
