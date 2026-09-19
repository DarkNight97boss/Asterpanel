import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let billing: typeof import("../src/lib/billing");
let pm: typeof import("../src/lib/payment-methods");
let gateways: typeof import("../src/modules/gateways");
let paypal: typeof import("../src/modules/gateways/paypal");
let clientId: string, companyId: string, productId: string;

const calls: { method: string; url: string; params: Record<string, string>; json?: Record<string, unknown>; headers: Record<string, string> }[] = [];
let decline = false;
let captureAmount = "";
const fake = (async (url: string, init: RequestInit = {}) => {
  const headers = init.headers as Record<string, string>;
  const raw = String(init.body ?? "");
  const call = { method: init.method ?? "GET", url, params: Object.fromEntries(new URLSearchParams(raw.startsWith("{") ? "" : raw)), json: raw.startsWith("{") ? JSON.parse(raw) : undefined, headers };
  calls.push(call);
  const ok = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (url.endsWith("/v1/customers")) return ok({ id: "cus_1" });
  if (url.endsWith("/v1/checkout/sessions")) return ok({ url: "https://checkout.stripe.com/c/pay_1" });
  if (url.includes("/v1/payment_intents/pi_checkout")) return ok({ id: "pi_checkout", customer: "cus_1", payment_method: { id: "pm_1", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } } });
  if (url.endsWith("/v1/payment_intents")) return decline ? ok({ error: { message: "Your card was declined.", decline_code: "insufficient_funds" } }, 402) : ok({ id: `pi_auto_${call.headers["Idempotency-Key"]}`, status: "succeeded", amount_received: Number(call.params.amount) });
  if (url.endsWith("/detach")) return ok({});
  if (url.endsWith("/v1/oauth2/token")) return ok({ access_token: "tok" });
  if (url.endsWith("/v2/checkout/orders")) return ok({ id: "ORDER1234567", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1234567" }] });
  if (url.endsWith("/capture")) return ok({ id: "ORDER1234567", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", custom_id: captureAmount.split("|")[1], amount: { currency_code: "EUR", value: captureAmount.split("|")[0] } }] } }] });
  return ok({}, 404);
}) as unknown as typeof fetch;

before(async () => {
  dbm = await import("../src/db");
  billing = await import("../src/lib/billing");
  pm = await import("../src/lib/payment-methods");
  gateways = await import("../src/modules/gateways");
  paypal = await import("../src/modules/gateways/paypal");
  (await import("../src/modules/gateways/http")).setGatewayHttpForTests(fake);
  const { updateSettings } = await import("../src/lib/settings");
  await updateSettings("gateways", { bankTransfer: { enabled: false }, stripe: { enabled: true, secretKey: "sk_test_x", webhookSecret: "whsec_x", saveCards: true }, paypal: { enabled: true, clientId: "cid", secret: "sec", webhookId: "wh", sandbox: true } });
  const db = await dbm.getDb();
  [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "pay@example.test", passwordHash: "x" }).returning();
  [{ id: companyId }] = await db.insert(dbm.schema.companies).values({ name: "Payer Ltd" }).returning();
  const [g] = await db.insert(dbm.schema.productGroups).values({ slug: "g", name: "G" }).returning();
  [{ id: productId }] = await db.insert(dbm.schema.products).values({ groupId: g.id, slug: "p", name: "Plan", requiresDomain: false, pricing: { monthly: 1000 } }).returning();
});

const invoiceOf = async (id: string) => (await (await dbm.getDb()).select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, id)))[0];

test("the admin's switches decide which methods customers see", async () => {
  assert.deepEqual((await gateways.enabledGateways()).map((g) => g.id), ["stripe", "paypal"]);
  const { updateSettings, getSettings } = await import("../src/lib/settings");
  const s = await getSettings("gateways");
  await updateSettings("gateways", { ...s, paypal: { ...s.paypal, enabled: false }, bankTransfer: { enabled: true } });
  assert.deepEqual((await gateways.enabledGateways()).map((g) => g.id), ["stripe", "bank-transfer"]);
  await updateSettings("gateways", s);
});

test("Stripe: checkout ties the payment to the company's customer and keeps the card; renewals are then charged off-session", async () => {
  const db = await dbm.getDb();
  const { invoiceId, serviceId } = await billing.placeOrder({ clientId, companyId, productId, cycle: "monthly", domain: "" });
  const stripe = (await gateways.enabledGateways()).find((g) => g.id === "stripe")!;
  const start = await stripe.start({ invoice: await invoiceOf(invoiceId), email: "pay@example.test", returnUrl: "https://panel.test/client/invoices/x", label: "INV-1" });
  assert.deepEqual(start, { kind: "redirect", url: "https://checkout.stripe.com/c/pay_1" });
  const session = calls.find((c) => c.url.endsWith("/checkout/sessions"))!;
  assert.deepEqual([session.params.customer, session.params["payment_intent_data[setup_future_usage]"], session.params["metadata[invoice_id]"], session.params.customer_email], ["cus_1", "off_session", invoiceId, undefined]);

  // What the webhook does once Stripe confirms.
  await billing.recordPayment({ invoiceId, gateway: "stripe", externalId: "pi_checkout", amount: (await invoiceOf(invoiceId)).total });
  await pm.rememberStripeCard("pi_checkout");
  await pm.rememberStripeCard("pi_checkout");
  const cards = await pm.listPaymentMethods(companyId);
  assert.deepEqual(cards.map((c) => [c.brand, c.last4, c.isDefault, c.externalId]), [["visa", "4242", true, "pm_1"]], "saved once, as the default");
  assert.ok(!JSON.stringify(cards).match(/\d{12,}/), "no card number anywhere");

  // Renewal: invoiced by the billing run, then charged without the customer.
  const [svc] = await db.select().from(dbm.schema.services).where(eq(dbm.schema.services.id, serviceId));
  await billing.runAutomation(new Date(svc.nextDueDate!.getTime() - 86_400_000));
  const renewal = (await db.select().from(dbm.schema.invoices)).find((i) => i.status === "unpaid")!;
  calls.length = 0;
  assert.deepEqual(await pm.runAutoCharges(), { paid: 1, failed: 0 });
  const charge = calls.find((c) => c.url.endsWith("/v1/payment_intents"))!;
  assert.deepEqual([charge.params.amount, charge.params.customer, charge.params.payment_method, charge.params.off_session, charge.params.confirm, charge.headers["Idempotency-Key"]], [String(renewal.total), "cus_1", "pm_1", "true", "true", `autocharge-${renewal.id}-1`]);
  assert.equal((await invoiceOf(renewal.id)).status, "paid");
  assert.deepEqual(await pm.runAutoCharges(), { paid: 0, failed: 0 }, "nothing left to charge");
});

test("a declined card is retried on day 3 and 5, then left to the customer; opting out or removing the card stops it", async () => {
  const db = await dbm.getDb();
  const { invoiceId } = await billing.placeOrder({ clientId, companyId, productId, cycle: "monthly", domain: "" });
  decline = true;
  const t0 = new Date();
  const at = (days: number) => new Date(t0.getTime() + days * 86_400_000 + 60_000);
  assert.deepEqual(await pm.runAutoCharges(t0), { paid: 0, failed: 1 });
  let inv = await invoiceOf(invoiceId);
  assert.deepEqual([inv.status, inv.chargeAttempts, inv.lastChargeError], ["unpaid", 1, "Your card was declined."]);
  assert.deepEqual(await pm.runAutoCharges(at(1)), { paid: 0, failed: 0 }, "too early");
  assert.deepEqual(await pm.runAutoCharges(at(3)), { paid: 0, failed: 1 });
  await db.update(dbm.schema.invoices).set({ lastChargeAt: t0 }).where(eq(dbm.schema.invoices.id, invoiceId));
  assert.deepEqual(await pm.runAutoCharges(at(4)), { paid: 0, failed: 1 }, "third and last try");
  assert.deepEqual(await pm.runAutoCharges(at(30)), { paid: 0, failed: 0 }, "no fourth attempt");
  inv = await invoiceOf(invoiceId);
  assert.equal(inv.chargeAttempts, 3);

  decline = false;
  await db.update(dbm.schema.invoices).set({ chargeAttempts: 0, lastChargeAt: null }).where(eq(dbm.schema.invoices.id, invoiceId));
  await db.update(dbm.schema.companies).set({ autoPay: false }).where(eq(dbm.schema.companies.id, companyId));
  assert.equal(await pm.chargeInvoice(invoiceId), "skipped", "the customer turned automatic payments off");
  await db.update(dbm.schema.companies).set({ autoPay: true }).where(eq(dbm.schema.companies.id, companyId));
  const [card] = await pm.listPaymentMethods(companyId);
  await pm.removePaymentMethod("00000000-0000-4000-8000-000000000000", card.id);
  assert.equal((await pm.listPaymentMethods(companyId)).length, 1, "another company cannot remove it");
  await pm.removePaymentMethod(companyId, card.id);
  assert.ok(calls.some((c) => c.url.endsWith("/payment_methods/pm_1/detach")));
  assert.equal(await pm.chargeInvoice(invoiceId), "skipped", "no card, no charge");
  assert.equal((await invoiceOf(invoiceId)).chargeAttempts, 0, "a skipped charge does not use up an attempt");
});

test("PayPal: the order carries the invoice, and only PayPal's capture answer decides what was paid", async () => {
  const { invoiceId } = await billing.placeOrder({ clientId, companyId, productId, cycle: "monthly", domain: "" });
  const inv = await invoiceOf(invoiceId);
  const gw = (await gateways.enabledGateways()).find((g) => g.id === "paypal")!;
  calls.length = 0;
  const start = await gw.start({ invoice: inv, email: "pay@example.test", returnUrl: `https://panel.test/client/invoices/${invoiceId}`, label: "INV-9" });
  assert.deepEqual(start, { kind: "redirect", url: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1234567" });
  const order = calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!;
  assert.ok(order.url.startsWith("https://api-m.sandbox.paypal.com"));
  const unit = (order.json!.purchase_units as { custom_id: string; amount: { value: string; currency_code: string } }[])[0];
  assert.deepEqual([unit.custom_id, unit.amount.value, unit.amount.currency_code], [invoiceId, paypal.paypalAmount(inv.total), inv.currency]);
  assert.equal((order.json!.payment_source as { paypal: { experience_context: { return_url: string } } }).paypal.experience_context.return_url, "https://panel.test/api/paypal/return");

  captureAmount = `${paypal.paypalAmount(inv.total)}|${invoiceId}`;
  assert.deepEqual(await paypal.capturePayPalOrder("ORDER1234567"), { captureId: "CAP1", invoiceId, cents: inv.total, currency: "EUR" });
  assert.equal(await paypal.capturePayPalOrder("../../v1/x"), null, "order ids are validated before they reach a URL");
  captureAmount = `1.00|not-an-invoice`;
  assert.equal(await paypal.capturePayPalOrder("ORDER1234567"), null);

  // An underpaid capture is recorded but does not settle the invoice.
  await billing.recordPayment({ invoiceId, gateway: "paypal", externalId: "CAP-SHORT", amount: 100 });
  assert.equal((await invoiceOf(invoiceId)).status, "unpaid");
  await billing.recordPayment({ invoiceId, gateway: "paypal", externalId: "CAP1", amount: inv.total - 100 });
  await billing.recordPayment({ invoiceId, gateway: "paypal", externalId: "CAP1", amount: inv.total - 100 });
  assert.equal((await invoiceOf(invoiceId)).status, "paid", "idempotent on the capture id");
});
