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

test("invoice numbers are progressive per fiscal year and a failed order leaves no gap", async () => {
  const db = await dbm.getDb();
  const year = new Date().getUTCFullYear();
  const numbers = async () => (await db.select().from(dbm.schema.invoices)).filter((i) => i.fiscalYear === year).map((i) => i.number).sort((a, b) => a - b);
  const before = await numbers();
  assert.deepEqual(before, before.map((_, i) => i + 1), "1..n with no holes so far");

  await assert.rejects(billing.placeOrder({ clientId, productId, cycle: "annually", domain: "gap.com" }), billing.BillingError);
  await assert.rejects(billing.placeOrder({ clientId: "00000000-0000-4000-8000-000000000000", productId, cycle: "monthly", domain: "gap.com" }), "unknown client: the insert fails inside the transaction");
  await billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "next.com" });
  const after = await numbers();
  assert.equal(after.length, before.length + 1);
  assert.equal(after.at(-1), before.length + 1, "the rolled-back attempt gave its number back");

  // A renewal run dated next year starts that year's series at 1.
  const [svc] = await db.select().from(dbm.schema.services);
  const nextYear = new Date(Date.UTC(year + 1, 5, 1));
  await db.update(dbm.schema.services).set({ status: "active", nextDueDate: nextYear, renewalInvoicedFor: null }).where(eq(dbm.schema.services.id, svc.id));
  await billing.runAutomation(nextYear);
  const first = (await db.select().from(dbm.schema.invoices)).filter((i) => i.fiscalYear === year + 1);
  assert.deepEqual(first.map((i) => i.number), [1]);
  const { invoiceLabel } = await import("../src/lib/format");
  assert.equal(invoiceLabel("INV-", first[0]), `INV-${year + 1}/0001`);
  assert.equal(invoiceLabel("INV-", { number: 7, fiscalYear: 0 }), "INV-7", "legacy invoices keep their old label");
});
