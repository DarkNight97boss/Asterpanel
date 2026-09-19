import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let billing: typeof import("../src/lib/billing");
let clientId: string, companyId: string, small: string, big: string, other: string;

before(async () => {
  dbm = await import("../src/db");
  billing = await import("../src/lib/billing");
  const db = await dbm.getDb();
  [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "cp@example.test", passwordHash: "x" }).returning();
  [{ id: companyId }] = await db.insert(dbm.schema.companies).values({ name: "Credit Ltd" }).returning();
  const [g] = await db.insert(dbm.schema.productGroups).values({ slug: "g", name: "G" }).returning();
  const [g2] = await db.insert(dbm.schema.productGroups).values({ slug: "g2", name: "G2" }).returning();
  const mk = async (slug: string, monthly: number, groupId = g.id) => (await db.insert(dbm.schema.products).values({ groupId, slug, name: slug, requiresDomain: false, pricing: { monthly } }).returning())[0].id;
  small = await mk("small", 1000);
  big = await mk("big", 3000);
  other = await mk("elsewhere", 5000, g2.id);
});

const company = async () => (await (await dbm.getDb()).select().from(dbm.schema.companies).where(eq(dbm.schema.companies.id, companyId)))[0];
const invoiceOf = async (id: string) => (await (await dbm.getDb()).select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, id)))[0];
const serviceOf = async (id: string) => (await (await dbm.getDb()).select().from(dbm.schema.services).where(eq(dbm.schema.services.id, id)))[0];

test("credit: never negative, spent on new invoices first, and what is left is what gateways charge", async () => {
  const db = await dbm.getDb();
  await assert.rejects(billing.adjustCredit(companyId, -100, "oops"), /does not have that much credit/);
  await assert.rejects(billing.adjustCredit(companyId, 0, "nothing"), /Enter an amount/);
  assert.equal(await billing.adjustCredit(companyId, 1500, "Welcome gift"), 1500);

  // Fully covered: paid on the spot, service active, balance reduced.
  const a = await billing.placeOrder({ clientId, companyId, productId: small, cycle: "monthly", domain: "" });
  assert.deepEqual([(await invoiceOf(a.invoiceId)).status, (await serviceOf(a.serviceId)).status, (await company()).creditBalance], ["paid", "active", 500]);

  // Partly covered: the rest stays due.
  const b = await billing.placeOrder({ clientId, companyId, productId: small, cycle: "monthly", domain: "" });
  assert.deepEqual([(await invoiceOf(b.invoiceId)).status, await billing.invoiceDue(b.invoiceId), (await company()).creditBalance], ["unpaid", 500, 0]);
  assert.equal(await billing.applyCredit(b.invoiceId), 0, "nothing left to spend, and asking again is harmless");
  await billing.recordPayment({ invoiceId: b.invoiceId, gateway: "bank", externalId: "rest", amount: 500 });
  assert.equal((await invoiceOf(b.invoiceId)).status, "paid");

  const ledger = await db.select().from(dbm.schema.creditLedger).where(eq(dbm.schema.creditLedger.companyId, companyId));
  assert.equal(ledger.reduce((s, l) => s + l.amount, 0), (await company()).creditBalance, "the balance is the sum of the ledger");
  assert.deepEqual(ledger.map((l) => l.amount).sort((x, y) => x - y), [-1000, -500, 1500]);
});

test("plan change: upgrade waits for its pro-rated invoice, downgrade is immediate and credits the difference", async () => {
  const db = await dbm.getDb();
  assert.equal(billing.remainingFraction(new Date("2026-10-01T00:00:00Z"), "monthly", new Date("2026-09-16T00:00:00Z")), 0.5);
  assert.equal(billing.remainingFraction(new Date("2026-10-01T00:00:00Z"), "monthly", new Date("2027-01-01T00:00:00Z")), 0);

  const { invoiceId, serviceId } = await billing.placeOrder({ clientId, companyId, productId: small, cycle: "monthly", domain: "" });
  await assert.rejects(billing.changePlan(serviceId, big), /Only active services/);
  await billing.recordPayment({ invoiceId, gateway: "bank", externalId: "p1", amount: (await invoiceOf(invoiceId)).total });
  assert.deepEqual((await billing.planOptions(serviceId)).map((p) => p.id), [big], "same group only, not the current plan");
  await assert.rejects(billing.changePlan(serviceId, other), /not available/);

  const due = (await serviceOf(serviceId)).nextDueDate!;
  const start = new Date(due); start.setUTCMonth(start.getUTCMonth() - 1);
  const half = new Date((start.getTime() + due.getTime()) / 2);

  const up = await billing.changePlan(serviceId, big, null, half);
  const upInv = await invoiceOf(up.invoiceId!);
  assert.equal(upInv.subtotal, 1000, "half a month of the 20.00 difference");
  assert.equal((await serviceOf(serviceId)).productId, small, "still on the old plan until paid");
  await assert.rejects(billing.changePlan(serviceId, big, null, half), /already waiting/);
  await billing.recordPayment({ invoiceId: upInv.id, gateway: "bank", externalId: "p2", amount: upInv.total });
  let svc = await serviceOf(serviceId);
  assert.deepEqual([svc.productId, svc.amount, (svc.moduleData as { pendingPlan?: unknown }).pendingPlan, svc.nextDueDate?.getTime()], [big, 3000, undefined, due.getTime()], "new price, same renewal date");

  const before = (await company()).creditBalance;
  const down = await billing.changePlan(serviceId, small, null, half);
  svc = await serviceOf(serviceId);
  assert.deepEqual([down.invoiceId, down.credited, svc.productId, svc.amount, (await company()).creditBalance - before], [null, 1000, small, 1000, 1000]);

  // A cancelled upgrade invoice does not lock the service forever.
  await billing.adjustCredit(companyId, -(await company()).creditBalance, "spent elsewhere");
  const again = await billing.changePlan(serviceId, big, null, half);
  await db.update(dbm.schema.invoices).set({ status: "cancelled" }).where(eq(dbm.schema.invoices.id, again.invoiceId!));
  const retry = await billing.changePlan(serviceId, big, null, half);
  assert.ok(retry.invoiceId && retry.invoiceId !== again.invoiceId);
  assert.equal((await serviceOf(serviceId)).productId, small);

  // Credit added later pays the waiting upgrade, and the plan changes at that moment.
  await billing.adjustCredit(companyId, 5000, "top-up");
  assert.equal(await billing.applyCredit(retry.invoiceId!), 1000);
  assert.deepEqual([(await invoiceOf(retry.invoiceId!)).status, (await serviceOf(serviceId)).productId, (await company()).creditBalance], ["paid", big, 4000]);
});
