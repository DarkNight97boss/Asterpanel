import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let billing: typeof import("../src/lib/billing");
let settings: typeof import("../src/lib/settings");
let clientId: string, productId: string;
const DAY = 86_400_000;

before(async () => {
  dbm = await import("../src/db");
  billing = await import("../src/lib/billing");
  settings = await import("../src/lib/settings");
  const db = await dbm.getDb();
  [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "leave@example.test", passwordHash: "x" }).returning();
  const [group] = await db.insert(dbm.schema.productGroups).values({ slug: "g", name: "G" }).returning();
  [{ id: productId }] = await db.insert(dbm.schema.products).values({ groupId: group.id, name: "Plan", slug: "plan", module: "manual", requiresDomain: false, pricing: { monthly: 1000 } }).returning();
  await settings.updateSettings("billing", { taxRate: 2200, invoiceDaysBeforeDue: 14, suspendDaysAfterDue: 90, terminateDaysAfterDue: 0, overdueReminderDays: [] });
});

const service = async (id: string) => (await (await dbm.getDb()).select().from(dbm.schema.services).where(eq(dbm.schema.services.id, id)))[0];
const invoice = async (id: string) => (await (await dbm.getDb()).select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, id)))[0];
async function activeService() {
  const { invoiceId, serviceId } = await billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "" });
  await billing.recordPayment({ invoiceId, gateway: "bank", externalId: `pay-${serviceId}`, amount: (await invoice(invoiceId)).total });
  return serviceId;
}

test("cancel at period end: no renewal is invoiced, the service runs until its date, then ends; undo brings the renewal back", async () => {
  const db = await dbm.getDb();
  const id = await activeService();
  const due = (await service(id)).nextDueDate!;
  await billing.requestCancellation(id, "  Too expensive  ");
  let svc = await service(id);
  assert.deepEqual([svc.status, svc.cancelAtPeriodEnd, svc.cancelReason], ["active", true, "Too expensive"]);

  const soon = new Date(due.getTime() - 5 * DAY);
  assert.equal((await billing.runAutomation(soon)).invoiced, 0, "inside the invoicing window, but leaving");
  assert.equal((await service(id)).status, "active");

  await billing.undoCancellation(id);
  assert.equal((await billing.runAutomation(soon)).invoiced, 1);
  // Asked again with the renewal already issued: the untouched invoice is withdrawn.
  const [line] = await db.select().from(dbm.schema.invoiceItems).where(eq(dbm.schema.invoiceItems.serviceId, id)).then((rows) => rows.filter((r) => r.kind === "renewal"));
  await billing.requestCancellation(id, "");
  assert.equal((await invoice(line.invoiceId)).status, "cancelled");

  const report = await billing.runAutomation(new Date(due.getTime() + 60_000));
  assert.deepEqual([report.cancelled, report.invoiced], [1, 0]);
  svc = await service(id);
  assert.equal(svc.status, "terminated");
  await assert.rejects(billing.requestCancellation(id, ""), /cannot be cancelled/);
});

test("a renewal invoice shared with another service only loses the leaving service's line", async () => {
  const db = await dbm.getDb();
  const [stay, leave] = [await activeService(), await activeService()];
  const due = (await service(stay)).nextDueDate!;
  await billing.runAutomation(new Date(due.getTime() - 5 * DAY));
  const items = await db.select().from(dbm.schema.invoiceItems).where(eq(dbm.schema.invoiceItems.serviceId, leave)).then((rows) => rows.filter((r) => r.kind === "renewal"));
  const shared = items[0].invoiceId;
  assert.equal((await invoice(shared)).subtotal, 2000);
  await billing.requestCancellation(leave, "");
  const after = await invoice(shared);
  assert.deepEqual([after.status, after.subtotal, after.tax, after.total], ["unpaid", 1000, 220, 1220]);
});

test("late fee: once, after the set days, with tax, never on paid or SDI-sent invoices", async () => {
  const db = await dbm.getDb();
  const { invoiceId } = await billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "" });
  const { invoiceId: sentId } = await billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "" });
  await db.update(dbm.schema.invoices).set({ sdiId: "sdi-1" }).where(eq(dbm.schema.invoices.id, sentId));
  const issued = (await invoice(invoiceId)).dueDate;

  assert.equal((await billing.runAutomation(new Date(issued.getTime() + 30 * DAY))).lateFees, 0, "switched off by default");
  await settings.updateSettings("billing", { lateFeeDays: 10, lateFeeFixed: 500, lateFeePercent: 10 });
  assert.equal((await billing.runAutomation(new Date(issued.getTime() + 9 * DAY))).lateFees, 0, "too early");
  const run = await billing.runAutomation(new Date(issued.getTime() + 11 * DAY));
  assert.ok(run.lateFees >= 1);
  const inv = await invoice(invoiceId);
  assert.deepEqual([inv.subtotal, inv.tax, inv.total], [1600, 352, 1952]);
  const fee = (await db.select().from(dbm.schema.invoiceItems).where(eq(dbm.schema.invoiceItems.invoiceId, invoiceId))).filter((i) => i.kind === "late_fee");
  assert.deepEqual(fee.map((f) => f.amount), [600]);
  assert.equal((await invoice(sentId)).subtotal, 1000);

  // Other overdue invoices may get theirs on a later run; this one never gets a second.
  await billing.runAutomation(new Date(issued.getTime() + 40 * DAY));
  assert.equal((await invoice(invoiceId)).total, 1952, "never twice");
  // Paying the whole amount, fee included, settles it.
  await billing.recordPayment({ invoiceId, gateway: "bank", externalId: "late-1", amount: 1952 });
  assert.equal((await invoice(invoiceId)).status, "paid");
});
