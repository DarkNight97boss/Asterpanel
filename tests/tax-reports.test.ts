import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let billing: typeof import("../src/lib/billing");
let tax: typeof import("../src/lib/tax");
let clientId: string, productId: string;
let viesAnswer: unknown = { isValid: true, name: "MUSTER GMBH" };
let viesStatus = 200;

before(async () => {
  dbm = await import("../src/db");
  billing = await import("../src/lib/billing");
  tax = await import("../src/lib/tax");
  tax.setViesHttpForTests((async () => new Response(JSON.stringify(viesAnswer), { status: viesStatus })) as unknown as typeof fetch);
  const { getSettings, updateSettings } = await import("../src/lib/settings");
  await updateSettings("billing", { ...(await getSettings("billing")), currency: "EUR", taxRate: 2200 });
  const db = await dbm.getDb();
  [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "tax@example.test", passwordHash: "x" }).returning();
  const [g] = await db.insert(dbm.schema.productGroups).values({ slug: "g", name: "G" }).returning();
  [{ id: productId }] = await db.insert(dbm.schema.products).values({ groupId: g.id, slug: "p", name: "Plan", requiresDomain: false, pricing: { monthly: 1000, annually: 12000 } }).returning();
});

const company = async (values: Partial<typeof dbm.schema.companies.$inferInsert>) => (await (await dbm.getDb()).insert(dbm.schema.companies).values({ name: "Co", ...values }).returning())[0];
const invoiceOf = async (id: string) => (await (await dbm.getDb()).select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, id)))[0];

test("reverse charge: only for a VIES-confirmed business in another EU country", async () => {
  const german = await company({ vatId: "DE123456789", country: "Germany" });
  let inv = await invoiceOf((await billing.placeOrder({ clientId, companyId: german.id, productId, cycle: "monthly", domain: "" })).invoiceId);
  assert.deepEqual([inv.taxRate, inv.tax], [2200, 220], "not verified yet: normal VAT");

  assert.equal(await tax.validateCompanyVat(german.id), "valid");
  inv = await invoiceOf((await billing.placeOrder({ clientId, companyId: german.id, productId, cycle: "monthly", domain: "" })).invoiceId);
  assert.deepEqual([inv.taxRate, inv.tax, inv.total, inv.notes.startsWith("Reverse charge")], [0, 0, 1000, true]);

  const italian = await company({ vatId: "IT01234567890", country: "Italia" });
  await tax.validateCompanyVat(italian.id);
  assert.equal((await tax.taxFor(italian.id)).rate, 2200, "same country as the seller: VAT applies");
  const swiss = await company({ vatId: "CHE123456789", country: "Switzerland" });
  assert.equal(await tax.validateCompanyVat(swiss.id), "invalid", "not an EU number: VIES is not even asked");
  const person = await company({ vatId: "FR12345678901", country: "France", orgType: "individual" });
  await tax.validateCompanyVat(person.id);
  assert.equal((await tax.taxFor(person.id)).rate, 2200, "consumers pay VAT");

  viesAnswer = { isValid: false };
  const fake = await company({ vatId: "NL000000000B01", country: "Netherlands" });
  assert.equal(await tax.validateCompanyVat(fake.id), "invalid");
  viesStatus = 500;
  assert.equal(await tax.validateCompanyVat(german.id), "unavailable");
  assert.equal((await tax.taxFor(german.id)).rate, 0, "VIES being down does not take away an earlier confirmation");
  viesStatus = 200;
});

test("FatturaPA: reverse charge uses N2.1, and the stamp duty only goes on the seller's own VAT-free invoices", async () => {
  const { buildFatturaPa } = await import("../src/lib/fatturapa");
  const seller = { name: "Aster", vatCountry: "IT", vatNumber: "01234567890", fiscalCode: "", regime: "RF19", address: "Via Roma 1", zip: "00100", city: "Roma", province: "RM", zeroVatNature: "N2.2", zeroVatNote: "Franchigia", iban: "", bollo: true };
  const buyer = { name: "Muster GmbH", firstName: "", lastName: "", isCompany: true, vatId: "DE123456789", taxCode: "", address: "Hauptstr. 1", zip: "10115", city: "Berlin", province: "", country: "DE", sdiCode: "", pec: "" };
  const inv = { number: "INV-2026/0001", progressive: 1, date: new Date("2026-09-19"), dueDate: new Date("2026-09-19"), currency: "EUR", taxRateBp: 0, subtotal: 10_000, tax: 0, total: 10_000, paid: true, paidBy: "card" as const, lines: [{ description: "Plan", amount: 10_000 }] };
  const flat = buildFatturaPa(seller, { ...buyer, country: "IT", vatId: "IT09876543210", zip: "20100", province: "MI" }, inv);
  assert.ok(flat.includes("<Natura>N2.2</Natura>") && flat.includes("<DatiBollo><BolloVirtuale>SI</BolloVirtuale><ImportoBollo>2.00</ImportoBollo></DatiBollo>"));
  assert.ok(flat.indexOf("<DatiBollo>") < flat.indexOf("<ImportoTotaleDocumento>"), "schema order");
  const rc = buildFatturaPa(seller, buyer, { ...inv, exemption: { nature: "N2.1", note: "Inversione contabile" } });
  assert.ok(rc.includes("<Natura>N2.1</Natura>") && rc.includes("Inversione contabile") && !rc.includes("DatiBollo"));
  assert.ok(!buildFatturaPa(seller, buyer, { ...inv, subtotal: 5000, total: 5000 }).includes("DatiBollo"), "below the threshold");
  assert.ok(!buildFatturaPa({ ...seller, bollo: false }, buyer, inv).includes("DatiBollo"));
});

test("reports: MRR normalises cycles, credit is not counted twice, CSV is spreadsheet-safe", async () => {
  const db = await dbm.getDb();
  const { revenueReport, invoicesCsv, monthly } = await import("../src/lib/reports");
  assert.deepEqual([monthly(12000, "annually"), monthly(1000, "monthly"), monthly(3000, "quarterly")], [1000, 1000, 1000]);
  await db.delete(dbm.schema.transactions);
  const co = await company({ name: '=HYPERLINK("http://evil")', vatId: "IT00000000000" });
  const a = await billing.placeOrder({ clientId, companyId: co.id, productId, cycle: "monthly", domain: "" });
  const b = await billing.placeOrder({ clientId, companyId: co.id, productId, cycle: "annually", domain: "" });
  for (const o of [a, b]) await billing.recordPayment({ invoiceId: o.invoiceId, gateway: "bank", externalId: o.invoiceId, amount: (await invoiceOf(o.invoiceId)).total });
  await billing.adjustCredit(co.id, 5000, "gift");
  await billing.placeOrder({ clientId, companyId: co.id, productId, cycle: "monthly", domain: "" }); // paid by credit

  const r = await revenueReport();
  assert.equal(r.mrr, 3000, "10 + 120/12 + 10");
  assert.equal(r.arr, 36_000);
  assert.equal(r.months.at(-1)!.collected, 1220 + 14_640, "the credit-paid invoice adds no cash");
  assert.ok(r.customers >= 1 && r.churnRate === 0);

  const month = new Date().toISOString().slice(0, 7);
  const out = await invoicesCsv(month, (i) => `INV-${i.fiscalYear}/${i.number}`);
  const [head, ...rows] = out.split("\r\n");
  assert.ok(head.startsWith("number,type,date,status,customer"));
  assert.ok(rows.some((l) => l.includes(`"'=HYPERLINK(""http://evil"")"`)), "formula injection neutralised and quoted");
  const credit = await billing.issueCreditNote(a.invoiceId, "test");
  const after = await invoicesCsv(month, (i) => `INV-${i.fiscalYear}/${i.number}`);
  const creditRow = after.split("\r\n").find((l) => l.includes("credit_note"))!;
  assert.ok(creditRow.includes(",-10.00,") && credit, "credit notes are negative");
  await assert.rejects(invoicesCsv("2026-13", () => ""), /Invalid month/);
});
