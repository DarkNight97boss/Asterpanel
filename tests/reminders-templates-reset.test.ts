import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import type { Transporter } from "nodemailer";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";
process.env.APP_URL = "https://billing.example.test";

type Sent = { to: string; subject: string; html: string; text: string };
const outbox: Sent[] = [];
const DAY = 86_400_000;

let dbm: typeof import("../src/db");
let billing: typeof import("../src/lib/billing");
let notifyMod: typeof import("../src/lib/notify");
let reset: typeof import("../src/lib/password-reset");
let crypto: typeof import("../src/lib/crypto");
let clientId: string;
let invoiceId: string;

before(async () => {
  dbm = await import("../src/db");
  billing = await import("../src/lib/billing");
  notifyMod = await import("../src/lib/notify");
  reset = await import("../src/lib/password-reset");
  crypto = await import("../src/lib/crypto");
  const { setTransportForTests } = await import("../src/lib/mail/transport");
  const { updateSettings } = await import("../src/lib/settings");

  setTransportForTests({
    sendMail: async (m: { to: string; subject: string; html: string; text: string }) => {
      outbox.push({ to: m.to, subject: m.subject, html: m.html, text: m.text });
    },
  } as unknown as Transporter);
  await updateSettings("general", { siteName: "Acme Hosting" });

  const db = await dbm.getDb();
  const { users, productGroups, products } = dbm.schema;
  [{ id: clientId }] = await db
    .insert(users)
    .values({ email: "anna@example.test", passwordHash: await crypto.hashPassword("old-password-123"), firstName: "Anna" })
    .returning();
  const [group] = await db.insert(productGroups).values({ slug: "g", name: "G" }).returning();
  const [product] = await db.insert(products).values({ groupId: group.id, slug: "p", name: "Plan", pricing: { monthly: 1000 } }).returning();
  ({ invoiceId } = await billing.placeOrder({ clientId, productId: product.id, cycle: "monthly", domain: "example.com" }));
  await notifyMod.flushNotifications();
});

beforeEach(() => {
  outbox.length = 0;
});

test("overdue reminders fire once per threshold and catch up with a single email", async () => {
  const db = await dbm.getDb();
  const [{ dueDate }] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  const run = async (daysLate: number) => {
    const report = await billing.runAutomation(new Date(dueDate.getTime() + daysLate * DAY + 1000));
    await notifyMod.flushNotifications();
    return report.reminded;
  };

  assert.equal(await run(2), 0, "before the first threshold");
  assert.equal(await run(3), 1);
  assert.equal(await run(3), 0, "same day again");
  assert.equal(await run(20), 1, "7 and 14 were both missed → one email, not two");
  assert.equal(await run(40), 0, "all thresholds used");

  assert.equal(outbox.length, 2);
  assert.match(outbox[0].subject, /^Reminder: invoice INV-\d{4}\/0001 is overdue/);

  await billing.recordPayment({ invoiceId, gateway: "manual", externalId: "", amount: 1000 });
  await notifyMod.flushNotifications();
});

test("paid invoices are never reminded", async () => {
  const db = await dbm.getDb();
  await db.update(dbm.schema.invoices).set({ remindersSent: 0 });
  const report = await billing.runAutomation(new Date(Date.now() + 10 * DAY));
  assert.equal(report.reminded, 0);
});

test("admin overrides replace the wording, keep the structure, and can disable a template", async () => {
  const db = await dbm.getDb();
  const { emailTemplates } = dbm.schema;
  await db.insert(emailTemplates).values({
    id: "invoice.paid",
    subject: "Grazie {name}!\r\nBcc: evil@example.test",
    body: "Pagamento di {total} ricevuto.\n\nA presto, {site} <b>team</b>",
  });

  assert.deepEqual(await notifyMod.resendInvoice(invoiceId), { ok: true });
  const [mail] = outbox;
  assert.equal(mail.subject, "Grazie Anna! Bcc: evil@example.test", "subject is forced onto one line");
  assert.match(mail.text, /Pagamento di €10\.00 ricevuto\./);
  assert.match(mail.html, /A presto, Acme Hosting &lt;b&gt;team&lt;\/b&gt;/, "admin text is escaped too");
  assert.match(mail.html, /Thank you for your payment/, "empty heading falls back to the default");
  assert.match(mail.html, /\/client\/invoices\//, "the button survives an override");

  await db.update(emailTemplates).set({ enabled: false });
  const off = await notifyMod.resendInvoice(invoiceId);
  assert.equal(off.ok, false);
  assert.equal(outbox.length, 1);
});

test("password reset: single-use token, sessions revoked, no account enumeration", async () => {
  const db = await dbm.getDb();
  const { sessions, users, passwordResets } = dbm.schema;
  await db.insert(sessions).values({ id: "s1", userId: clientId, expiresAt: new Date(Date.now() + DAY) });

  await reset.requestPasswordReset("nobody@example.test");
  assert.equal(outbox.length, 0, "unknown address: silent");

  await reset.requestPasswordReset("anna@example.test");
  await reset.requestPasswordReset("anna@example.test");
  assert.equal((await db.select().from(passwordResets)).length, 1, "a new request invalidates the previous link");
  const token = decodeURIComponent(outbox[1].text.match(/reset-password\?token=([\w%-]+)/)![1]);
  const stale = decodeURIComponent(outbox[0].text.match(/reset-password\?token=([\w%-]+)/)![1]);

  assert.equal(await reset.resetTokenIsValid(stale), false);
  assert.equal(await reset.resetTokenIsValid(token), true);
  assert.equal(await reset.resetPassword("wrong-token", "new-password-456"), false);
  assert.equal(await reset.resetPassword(token, "new-password-456"), true);
  assert.equal(await reset.resetPassword(token, "another-password-789"), false, "single use");
  await notifyMod.flushNotifications();

  const [user] = await db.select().from(users).where(eq(users.id, clientId));
  assert.equal(await crypto.verifyPassword("new-password-456", user.passwordHash), true);
  assert.equal((await db.select().from(sessions)).length, 0, "existing sessions are revoked");
  assert.match(outbox.at(-1)!.subject, /password was changed/);

  await db.update(passwordResets).set({ expiresAt: new Date(0) });
  assert.equal(await reset.resetTokenIsValid(token), false);
});
