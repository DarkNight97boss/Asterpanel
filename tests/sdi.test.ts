import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let sdi: typeof import("../src/lib/sdi");
let billing: typeof import("../src/lib/billing");
let settings: typeof import("../src/lib/settings");
let clientId: string, companyId: string, productId: string;

const calls: { method: string; url: string; body: string; headers: Record<string, string> }[] = [];
const outcome = "delivered";
let refuse = false;
const fake = (async (url: string, init: RequestInit = {}) => {
  calls.push({ method: init.method ?? "GET", url, body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> });
  const ok = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (url.endsWith("/login")) return ok({ token: "jwt" });
  if (url.endsWith("/auth/signin")) return ok({ access_token: "aruba-token" });
  if (url.endsWith("/services/invoice/upload")) return refuse ? ok({ errorCode: "0012", errorDescription: "File already uploaded" }) : ok({ errorCode: "0000", uploadFileName: "IT01234567890_00001.xml.p7m" });
  if (url.includes("/getByFilename")) return ok({ invoices: [{ status: "Consegnata" }] });
  if (/acubeapi\.com\/invoices$/.test(url)) return refuse ? ok({ detail: "XML non valido: CodiceDestinatario" }, 422) : ok({ uuid: "acube-uuid" });
  if (/acubeapi\.com\/invoices\//.test(url)) return ok({ marking: outcome });
  if (/openapi\.it\/invoices$/.test(url)) return ok({ data: { uuid: "oa-uuid" } });
  if (url.endsWith("/send/xml")) return ok({ id: 77 });
  if (url.includes("/update?send_id=77")) return ok([{ state: "Scartato", description: "00311 CodiceDestinatario non valido" }]);
  if (url.endsWith("/info/vat_types")) return ok({ data: [{ id: 0, value: 22 }, { id: 9, value: 22, is_disabled: true }, { id: 6, value: 0 }] });
  if (url.endsWith("/issued_documents")) return ok({ data: { id: 5501 } });
  if (url.endsWith("/e_invoice/send")) return ok({ data: {} });
  return ok({}, 404);
}) as unknown as typeof fetch;

before(async () => {
  dbm = await import("../src/db");
  sdi = await import("../src/lib/sdi");
  billing = await import("../src/lib/billing");
  settings = await import("../src/lib/settings");
  sdi.setSdiHttpForTests(fake);
  const db = await dbm.getDb();
  await settings.updateSettings("billing", { ...(await settings.getSettings("billing")), currency: "EUR", taxRate: 2200 });
  await settings.updateSettings("einvoice", { ...(await settings.getSettings("einvoice")), enabled: true, name: "Aster S.r.l.", vatNumber: "01234567890", address: "Via Roma 1", zip: "00100", city: "Roma", province: "RM" });
  [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "sdi@example.test", passwordHash: "x", firstName: "Mario", lastName: "Rossi" }).returning();
  [{ id: companyId }] = await db.insert(dbm.schema.companies).values({ name: "Cliente S.p.A.", vatId: "IT09876543210", address1: "Corso Italia 5", zip: "20100", city: "Milano", state: "MI", country: "Italia", sdiCode: "ABC1234" }).returning();
  const [g] = await db.insert(dbm.schema.productGroups).values({ slug: "g", name: "G" }).returning();
  [{ id: productId }] = await db.insert(dbm.schema.products).values({ groupId: g.id, slug: "p", name: "Plan", requiresDomain: false, pricing: { monthly: 1000 } }).returning();
});

const use = (provider: string, account: Record<string, string>, autoSend: "manual" | "paid" = "manual") => settings.updateSettings("sdi", { provider, autoSend, accounts: { [provider]: account } });
const invoiceOf = async (id: string) => (await (await dbm.getDb()).select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, id)))[0];
async function paidInvoice() {
  const { invoiceId } = await billing.placeOrder({ clientId, companyId, productId, cycle: "monthly", domain: "" });
  await billing.recordPayment({ invoiceId, gateway: "bank", externalId: `t-${invoiceId}`, amount: (await invoiceOf(invoiceId)).total });
  return invoiceId;
}

test("status words of every intermediary collapse to the same outcomes", async () => {
  const { normalizeSdiStatus: n } = await import("../src/modules/sdi");
  assert.deepEqual(["delivered", "Consegnata", "RC", "accepted", "NE", "Decorrenza termini"].map(n), Array(6).fill("delivered"));
  assert.deepEqual(["rejected", "Scartato", "NS", "Notifica scarto", "invalid"].map(n), Array(5).fill("rejected"));
  assert.deepEqual(["MC", "Mancata consegna", "not_delivered", "Non consegnata"].map(n), Array(4).fill("not_delivered"));
  assert.deepEqual(["", "waiting", "Inviata", "processing"].map(n), Array(4).fill("sent"));
});

test("A-Cube: XML posted with a fresh token; refused files are reported, never re-sent by accident; outcome polled", async () => {
  await use("acube", { email: "a@b.it", password: "pw", sandbox: "1" });
  const id = await paidInvoice();
  calls.length = 0;
  await sdi.sendToSdi(id);
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/invoices"))!;
  assert.ok(post.url.startsWith("https://api-sandbox.acubeapi.com") && post.headers.Authorization === "Bearer jwt" && post.body.includes("<CodiceDestinatario>ABC1234</CodiceDestinatario>"));
  assert.deepEqual([(await invoiceOf(id)).sdiStatus, (await invoiceOf(id)).sdiId, (await invoiceOf(id)).sdiProvider], ["sent", "acube-uuid", "acube"]);
  await assert.rejects(sdi.sendToSdi(id), /already sent/);

  await (await dbm.getDb()).update(dbm.schema.invoices).set({ sdiSentAt: new Date(Date.now() - 3_600_000) }).where(eq(dbm.schema.invoices.id, id));
  assert.equal(await sdi.pollSdi(), 1);
  assert.equal((await invoiceOf(id)).sdiStatus, "delivered");
  assert.equal(await sdi.pollSdi(), 0, "final outcomes are not polled again");

  refuse = true;
  const bad = await paidInvoice();
  await assert.rejects(sdi.sendToSdi(bad), /CodiceDestinatario/);
  assert.deepEqual([(await invoiceOf(bad)).sdiStatus, (await invoiceOf(bad)).sdiMessage], ["error", "XML non valido: CodiceDestinatario"]);
  refuse = false;
  await sdi.sendToSdi(bad);
  assert.equal((await invoiceOf(bad)).sdiStatus, "sent", "a failed send can be retried");
});

test("Aruba uploads base64, Openapi and Invoicetronic post XML, Fatture in Cloud rebuilds the document", async () => {
  await use("aruba", { username: "u", password: "p", sandbox: "" });
  let id = await paidInvoice();
  calls.length = 0;
  await sdi.sendToSdi(id);
  const up = calls.find((c) => c.url.endsWith("/upload"))!;
  assert.ok(up.url.startsWith("https://ws.fatturazioneelettronica.aruba.it"));
  assert.ok(Buffer.from(JSON.parse(up.body).dataFile, "base64").toString().startsWith("<?xml"));
  await sdi.refreshSdiStatus(id);
  assert.equal((await invoiceOf(id)).sdiStatus, "delivered");

  await use("openapi", { token: "tok", sandbox: "1" });
  id = await paidInvoice();
  calls.length = 0;
  await sdi.sendToSdi(id);
  assert.deepEqual([calls[0].url, calls[0].headers.Authorization, (await invoiceOf(id)).sdiId], ["https://test.sdi.openapi.it/invoices", "Bearer tok", "oa-uuid"]);

  await use("invoicetronic", { apiKey: "ik_test_1" });
  id = await paidInvoice();
  await sdi.sendToSdi(id);
  await sdi.refreshSdiStatus(id);
  assert.deepEqual([(await invoiceOf(id)).sdiId, (await invoiceOf(id)).sdiStatus, (await invoiceOf(id)).sdiMessage], ["77", "rejected", "00311 CodiceDestinatario non valido"]);

  await use("fattureincloud", { token: "t", companyId: "12345" });
  id = await paidInvoice();
  calls.length = 0;
  await sdi.sendToSdi(id);
  const doc = JSON.parse(calls.find((c) => c.url.endsWith("/issued_documents"))!.body).data;
  assert.deepEqual([doc.type, doc.e_invoice, doc.entity.vat_number, doc.entity.ei_code, doc.entity.country_iso, doc.items_list[0].net_price, doc.items_list[0].vat.id, doc.payments_list[0].amount], ["invoice", true, "09876543210", "ABC1234", "IT", 10, 0, 12.2]);
  assert.ok(calls.at(-1)!.url.endsWith("/c/12345/issued_documents/5501/e_invoice/send"));
  await use("fattureincloud", { token: "t", companyId: "12345/../9" });
  await assert.rejects(sdi.sendToSdi(await paidInvoice()), /must be a number/);
});

test("automatic sending happens on payment, and a broken intermediary never blocks the payment", async () => {
  await use("acube", { email: "a@b.it", password: "pw" }, "paid");
  const id = await paidInvoice();
  assert.equal((await invoiceOf(id)).sdiStatus, "sent");
  refuse = true;
  const other = await paidInvoice();
  assert.deepEqual([(await invoiceOf(other)).status, (await invoiceOf(other)).sdiStatus], ["paid", "error"]);
  refuse = false;
  await settings.updateSettings("sdi", { provider: "", autoSend: "paid", accounts: {} });
  const none = await paidInvoice();
  assert.deepEqual([(await invoiceOf(none)).status, (await invoiceOf(none)).sdiStatus], ["paid", ""]);
  await assert.rejects(sdi.sendToSdi(none), /No SDI intermediary/);
});
