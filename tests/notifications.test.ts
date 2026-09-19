import assert from "node:assert/strict";
import { before, test } from "node:test";
import nodemailer, { type Transporter } from "nodemailer";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";
process.env.APP_URL = "https://billing.example.test/";

type Sent = { to: string; subject: string; html: string; text: string; attachments: { filename: string; content: string }[] };
const outbox: Sent[] = [];

let dbm: typeof import("../src/db");
let billing: typeof import("../src/lib/billing");
let notifyMod: typeof import("../src/lib/notify");
let clientId: string;
let productId: string;

before(async () => {
  dbm = await import("../src/db");
  billing = await import("../src/lib/billing");
  notifyMod = await import("../src/lib/notify");
  const { setTransportForTests } = await import("../src/lib/mail/transport");
  const { updateSettings } = await import("../src/lib/settings");

  const json = nodemailer.createTransport({ jsonTransport: true });
  setTransportForTests({
    sendMail: async (options: object) => {
      const info = await json.sendMail(options);
      const m = JSON.parse(info.message as unknown as string);
      outbox.push({ to: m.to[0].address, subject: m.subject, html: m.html, text: m.text, attachments: m.attachments ?? [] });
      return info;
    },
  } as unknown as Transporter);

  await updateSettings("general", { siteName: "Acme Hosting", locale: "it", supportEmail: "staff@example.test" });
  await updateSettings("billing", { taxRate: 2200 });

  const db = await dbm.getDb();
  const { users, productGroups, products } = dbm.schema;
  [{ id: clientId }] = await db
    .insert(users)
    .values({ email: "mario@example.test", passwordHash: "x", firstName: "Mario", lastName: "Rossi", company: "Società Città S.r.l." })
    .returning();
  const [group] = await db.insert(productGroups).values({ slug: "g", name: "G" }).returning();
  [{ id: productId }] = await db.insert(products).values({ groupId: group.id, slug: "p", name: "Piano Pro", pricing: { monthly: 1000 } }).returning();
});

test("order and payment send localized emails with the invoice PDF attached", async () => {
  const { invoiceId } = await billing.placeOrder({ clientId, productId, cycle: "monthly", domain: "esempio.it" });
  await notifyMod.flushNotifications();

  assert.equal(outbox.length, 1);
  const created = outbox[0];
  assert.equal(created.to, "mario@example.test");
  assert.match(created.subject, /^Fattura INV-\d{4}\/0001 /);
  assert.match(created.html, /Ciao Mario,/);
  assert.match(created.html, /https:\/\/billing\.example\.test\/client\/invoices\//, "links use APP_URL without a double slash");
  assert.match(created.text, /Totale: /);
  assert.match(created.attachments[0].filename, /^INV-\d{4}_0001\.pdf$/);
  assert.equal(Buffer.from(created.attachments[0].content, "base64").subarray(0, 5).toString(), "%PDF-");

  await billing.recordPayment({ invoiceId, gateway: "manual", externalId: "", amount: 1220 });
  await notifyMod.flushNotifications();

  const templates = (await (await dbm.getDb()).select().from(dbm.schema.emailLog)).map((e) => `${e.template}:${e.status}`).sort();
  assert.deepEqual(templates, ["invoice.created:sent", "invoice.paid:sent", "service.activated:sent"]);
  assert.ok(outbox.some((m) => /Pagamento ricevuto/.test(m.subject)));
});

test("HTML is escaped and a failing SMTP server is logged, never thrown", async () => {
  const { renderMail } = await import("../src/lib/mail/layout");
  const { getSettings } = await import("../src/lib/settings");
  const [general, theme] = await Promise.all([getSettings("general"), getSettings("theme")]);
  const { html } = renderMail({ subject: "s", heading: "h", paragraphs: [], quote: '<img src=x onerror="alert(1)">' }, { general, theme, origin: "" });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));

  const { setTransportForTests } = await import("../src/lib/mail/transport");
  setTransportForTests({ sendMail: async () => Promise.reject(new Error("connection refused")) } as unknown as Transporter);
  const result = await notifyMod.sendTestMail("x@example.test");
  assert.deepEqual(result, { ok: false, error: "connection refused" });
  const failed = (await (await dbm.getDb()).select().from(dbm.schema.emailLog)).filter((e) => e.status === "failed");
  assert.equal(failed.length, 1);
});

test("PDF renders non-Latin and exotic characters without throwing", async () => {
  const db = await dbm.getDb();
  await db.update(dbm.schema.users).set({ firstName: "Łukasz", lastName: "Жуков", address: "東京 → Roma" });
  const { loadInvoice } = await import("../src/lib/invoices");
  const { renderInvoicePdf } = await import("../src/lib/invoice-pdf");
  const [row] = await db.select().from(dbm.schema.invoices);
  const { bytes, filename } = await renderInvoicePdf((await loadInvoice(row.id))!);
  assert.match(filename, /^INV-\d{4}_0001\.pdf$/);
  assert.ok(bytes.length > 1500);
});
