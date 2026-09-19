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

test("companies own what they order: service, invoice and renewal follow the company, and invoices print its billing details", async () => {
  const db = await dbm.getDb();
  const [co] = await db.insert(dbm.schema.companies).values({ name: "Rossi Web Agency", billingName: "Rossi Web Agency S.r.l.", taxCode: "RSSMRA80A01H501U", vatId: "IT01234567890", address1: "Via Roma 1", address2: "Scala B", city: "Milano", zip: "20100", country: "Italy" }).returning();
  const { invoiceId } = await billing.placeOrder({ clientId, companyId: co.id, productId, cycle: "monthly", domain: "company.com" });
  const [inv] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  const [svc] = (await db.select().from(dbm.schema.services)).filter((s) => s.domain === "company.com");
  assert.deepEqual([inv.companyId, svc.companyId, inv.clientId], [co.id, co.id, clientId]);

  const { loadInvoice } = await import("../src/lib/invoices");
  const loaded = (await loadInvoice(invoiceId))!;
  assert.deepEqual([loaded.client.company, loaded.client.address, loaded.client.vatId, loaded.client.taxCode], ["Rossi Web Agency S.r.l.", "Via Roma 1, Scala B", "IT01234567890", "RSSMRA80A01H501U"]);

  // The renewal is billed to the same company, separately from the person's other services.
  const due = new Date(Date.now() + 400 * 86_400_000);
  await db.update(dbm.schema.services).set({ status: "active", nextDueDate: due, renewalInvoicedFor: null }).where(eq(dbm.schema.services.id, svc.id));
  await billing.runAutomation(new Date(due.getTime() - 86_400_000));
  const renewals = (await db.select().from(dbm.schema.invoices)).filter((i) => i.companyId === co.id && i.id !== invoiceId);
  assert.equal(renewals.length, 1);
});

test("credit notes: a paid invoice is reversed by a numbered document of its own, once, without touching services", async () => {
  const db = await dbm.getDb();
  const { invoiceId, serviceId } = await billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "credit.com" });
  await assert.rejects(billing.issueCreditNote(invoiceId, "changed mind"), /Only paid invoices/);
  const [inv] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  await billing.recordPayment({ invoiceId, gateway: "bank", externalId: "cn-1", amount: inv.total });

  const creditId = await billing.issueCreditNote(invoiceId, "Duplicate order");
  const [credit] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, creditId));
  const [after] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  assert.deepEqual([credit.kind, credit.creditsInvoiceId, credit.total, credit.status, after.status], ["credit_note", invoiceId, inv.total, "paid", "refunded"]);
  assert.equal(credit.fiscalYear, inv.fiscalYear);
  assert.ok(credit.number > inv.number, "same gapless series");
  assert.match(credit.notes, /Duplicate order/);
  const items = await db.select().from(dbm.schema.invoiceItems).where(eq(dbm.schema.invoiceItems.invoiceId, creditId));
  assert.ok(items.length > 0 && items.every((i) => i.serviceId === null));
  const [svc] = await db.select().from(dbm.schema.services).where(eq(dbm.schema.services.id, serviceId));
  assert.equal(svc.status, "active", "staff decides separately what happens to the service");
  await assert.rejects(billing.issueCreditNote(invoiceId, ""), /Only paid invoices/, "cannot be credited twice");
  await assert.rejects(billing.issueCreditNote(creditId, ""), /Invoice not found/, "a credit note cannot be credited");
});

test("coupons: discount the first invoice only, are claimed atomically and refuse the order when unusable", async () => {
  const db = await dbm.getDb();
  await db.insert(dbm.schema.coupons).values([{ code: "HALF", kind: "percent", value: 50, maxUses: 1 }, { code: "BIG", kind: "fixed", value: 9_999_999 }, { code: "OLD", kind: "percent", value: 10, expiresAt: new Date(Date.now() - 1000) }, { code: "OFF", kind: "percent", value: 10, enabled: false }]);
  const [product] = await db.select().from(dbm.schema.products).where(eq(dbm.schema.products.id, productId));
  const list = product.pricing.monthly! + (product.pricing.setup ?? 0);

  const { invoiceId, serviceId } = await billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "coupon.com", coupon: " half " });
  const [inv] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  assert.equal(inv.subtotal, list - Math.round(list / 2));
  const items = await db.select().from(dbm.schema.invoiceItems).where(eq(dbm.schema.invoiceItems.invoiceId, invoiceId));
  assert.deepEqual(items.filter((i) => i.kind === "discount").map((i) => [i.amount, i.serviceId, /HALF/.test(i.description)]), [[-Math.round(list / 2), null, true]]);
  assert.equal(items.reduce((s, i) => s + i.amount, 0), inv.subtotal, "lines add up to the subtotal");
  assert.equal((await db.select().from(dbm.schema.services).where(eq(dbm.schema.services.id, serviceId)))[0].amount, product.pricing.monthly, "renewals stay at list price");

  await assert.rejects(billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "again.com", coupon: "HALF" }), /used up/);
  for (const [code, why] of [["OLD", /expired/], ["OFF", /not valid/], ["NOPE", /not valid/]] as const) await assert.rejects(billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "x.com", coupon: code }), why);
  assert.ok(!(await db.select().from(dbm.schema.services)).some((s) => s.domain === "again.com" || s.domain === "x.com"), "a refused code creates nothing");

  // A discount larger than the order makes it free, never negative; free orders activate at once.
  const free = await billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "free.com", coupon: "BIG" });
  const [zero] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, free.invoiceId));
  assert.deepEqual([zero.total, zero.status], [0, "paid"]);
});

test("quotes: parsed strictly, accepted once into an invoice, never after expiry or by another company", async () => {
  const db = await dbm.getDb();
  const quotes = await import("../src/lib/quotes");
  const roles = await import("../src/lib/roles");
  assert.deepEqual(quotes.parseQuoteLines("Migration | 12 sites | 600.00\n\nAudit|250,5"), [{ description: "Migration | 12 sites", amount: 60_000 }, { description: "Audit", amount: 25_050 }]);
  for (const bad of ["no amount here", "Free | 0", " | 10.00", "Negative | -5", ""]) assert.throws(() => quotes.parseQuoteLines(bad), billing.BillingError, bad);

  const [user] = await db.select().from(dbm.schema.users).where(eq(dbm.schema.users.id, clientId));
  const companyId = await roles.createCompany(user, "Quoted Ltd");
  const other = await roles.createCompany(user, "Nosy Ltd");
  const id = await quotes.createQuote({ companyId, title: "Migration", lines: "Migration | 600.00\nAudit | 250.00", notes: "", validDays: 30, actorId: null });

  await assert.rejects(quotes.acceptQuote(id, other, null), /no longer open/, "another company cannot accept it");
  const invoiceId = await quotes.acceptQuote(id, companyId, null);
  const [inv] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  assert.deepEqual([inv.subtotal, inv.companyId, inv.status], [85_000, companyId, "unpaid"]);
  assert.match(inv.notes, /Migration — quote #\d+/);
  await assert.rejects(quotes.acceptQuote(id, companyId, null), /no longer open/, "only once");
  assert.equal((await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.companyId, companyId))).length, 1);

  const old = await quotes.createQuote({ companyId, title: "Old offer", lines: "Work | 100.00", notes: "", validDays: 1, actorId: null });
  await db.update(dbm.schema.quotes).set({ validUntil: new Date(Date.now() - 1000) }).where(eq(dbm.schema.quotes.id, old));
  await assert.rejects(quotes.acceptQuote(old, companyId, null), /expired/);
  assert.equal((await db.select().from(dbm.schema.quotes).where(eq(dbm.schema.quotes.id, old)))[0].status, "sent", "an expired quote is not marked accepted");
  await quotes.closeQuote(old, "withdrawn", null, null);
  await assert.rejects(quotes.acceptQuote(old, companyId, null), /no longer open/);
  await assert.rejects(billing.createCustomInvoice({ clientId, companyId, items: [{ description: "x", amount: 0 }] }), /at least one line/);
});
