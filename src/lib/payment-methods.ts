import "server-only";
import { and, asc, desc, eq, isNotNull, lt, or, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { StripeError, stripeCall, type StripeIntent } from "@/modules/gateways/stripe";
import { audit } from "./audit";
import { invoiceDue, recordPayment } from "./billing";
import { getSettings } from "./settings";

/**
 * Saved cards and automatic renewals. Card data never reaches this server:
 * Stripe keeps it, we keep the reference (`pm_…`) and what is printed on the card.
 */

/** The company's customer object at Stripe, created on first use. */
export async function stripeCustomer(companyId: string, email: string): Promise<string> {
  const db = await getDb();
  const [co] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
  if (!co) return "";
  if (co.stripeCustomerId) return co.stripeCustomerId;
  const customer = await stripeCall<{ id: string }>("POST", "/customers", { email, name: co.billingName || co.name, "metadata[company_id]": co.id }, `customer-${co.id}`);
  await db.update(schema.companies).set({ stripeCustomerId: customer.id }).where(eq(schema.companies.id, co.id));
  return customer.id;
}

/** `brand` of a saved SEPA direct debit mandate. */
export const SEPA = "sepa";

/** After a successful payment: keep the card it was made with, as the default if there is none yet. */
export async function rememberStripeCard(paymentIntentId: string): Promise<void> {
  if (!(await getSettings("gateways")).stripe.saveCards || !/^pi_\w+$/.test(paymentIntentId)) return;
  const intent = await stripeCall<StripeIntent>("GET", `/payment_intents/${paymentIntentId}`, { "expand[]": "payment_method" });
  const pm = typeof intent.payment_method === "object" ? intent.payment_method : null;
  // A card, or the SEPA mandate the customer accepted at checkout: both can pay renewals off-session.
  const kept = pm?.card ? { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year } : pm?.sepa_debit ? { brand: SEPA, last4: pm.sepa_debit.last4, expMonth: 0, expYear: 0 } : null;
  if (!pm || !kept || !intent.customer) return;
  const db = await getDb();
  const [co] = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.stripeCustomerId, intent.customer));
  if (!co) return;
  const [hasDefault] = await db.select({ id: schema.paymentMethods.id }).from(schema.paymentMethods).where(and(eq(schema.paymentMethods.companyId, co.id), eq(schema.paymentMethods.isDefault, true)));
  await db
    .insert(schema.paymentMethods)
    .values({ companyId: co.id, gateway: "stripe", externalId: pm.id, ...kept, isDefault: !hasDefault })
    .onConflictDoNothing();
}

export const listPaymentMethods = async (companyId: string) => (await getDb()).select().from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId)).orderBy(desc(schema.paymentMethods.isDefault), asc(schema.paymentMethods.createdAt));

export async function setDefaultPaymentMethod(companyId: string, id: string) {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [pm] = await tx.select({ id: schema.paymentMethods.id }).from(schema.paymentMethods).where(and(eq(schema.paymentMethods.id, id), eq(schema.paymentMethods.companyId, companyId)));
    if (!pm) return;
    await tx.update(schema.paymentMethods).set({ isDefault: false }).where(eq(schema.paymentMethods.companyId, companyId));
    await tx.update(schema.paymentMethods).set({ isDefault: true }).where(eq(schema.paymentMethods.id, pm.id));
  });
}

/** Forgets the card here and at Stripe. The next oldest card becomes the default. */
export async function removePaymentMethod(companyId: string, id: string) {
  const db = await getDb();
  const [pm] = await db.select().from(schema.paymentMethods).where(and(eq(schema.paymentMethods.id, id), eq(schema.paymentMethods.companyId, companyId)));
  if (!pm) return;
  await stripeCall("POST", `/payment_methods/${pm.externalId}/detach`).catch(() => {}); // already gone at Stripe is fine
  await db.delete(schema.paymentMethods).where(eq(schema.paymentMethods.id, pm.id));
  if (pm.isDefault) {
    const [next] = await db.select({ id: schema.paymentMethods.id }).from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId)).orderBy(asc(schema.paymentMethods.createdAt)).limit(1);
    if (next) await db.update(schema.paymentMethods).set({ isDefault: true }).where(eq(schema.paymentMethods.id, next.id));
  }
}

// ─── Automatic charges ───────────────────────────────────────────────────────

/** First try when the invoice is issued, then after 3 and 5 more days. Then it is the customer's turn. */
export const CHARGE_RETRY_DAYS = [0, 3, 5];
const DAY = 86_400_000;

/** `pending`: a bank debit was started; the webhook settles it days later. */
export type ChargeOutcome = "paid" | "failed" | "skipped" | "pending";

/** One off-session charge of an unpaid invoice on the company's default card. */
export async function chargeInvoice(invoiceId: string): Promise<ChargeOutcome> {
  const db = await getDb();
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv || inv.status !== "unpaid" || inv.kind !== "invoice" || inv.total <= 0 || !inv.companyId) return "skipped";
  const [co] = await db.select().from(schema.companies).where(eq(schema.companies.id, inv.companyId));
  const [pm] = await db.select().from(schema.paymentMethods).where(and(eq(schema.paymentMethods.companyId, inv.companyId), eq(schema.paymentMethods.isDefault, true), eq(schema.paymentMethods.gateway, "stripe")));
  if (!co?.autoPay || !co.stripeCustomerId || !pm) return "skipped";
  // A debit already on its way to the bank: charging again would take the money twice.
  if (inv.chargePendingRef) return "skipped";

  const due = await invoiceDue(inv.id);
  if (due <= 0) return "skipped";
  const attempt = inv.chargeAttempts + 1;
  // Counted before the call: a crash mid-way can never turn into an endless retry loop.
  await db.update(schema.invoices).set({ chargeAttempts: attempt, lastChargeAt: new Date() }).where(eq(schema.invoices.id, inv.id));
  try {
    const intent = await stripeCall<StripeIntent>(
      "POST",
      "/payment_intents",
      { amount: String(due), currency: inv.currency.toLowerCase(), customer: co.stripeCustomerId, payment_method: pm.externalId, off_session: "true", confirm: "true", "metadata[invoice_id]": inv.id, description: `Invoice ${inv.fiscalYear}/${inv.number}` },
      // Same key for the same attempt: a retried request cannot charge twice.
      `autocharge-${inv.id}-${attempt}`,
    );
    if (intent.status === "processing") {
      await db.update(schema.invoices).set({ chargePendingRef: intent.id, lastChargeError: "" }).where(eq(schema.invoices.id, inv.id));
      await audit(null, "invoice.autocharge_pending", "invoice", inv.id, { method: pm.brand, last4: pm.last4 });
      return "pending";
    }
    if (intent.status !== "succeeded") throw new StripeError(intent.status === "requires_action" ? "The bank asks the cardholder to confirm this payment" : `Payment ${intent.status}`, intent.status);
    await recordPayment({ invoiceId: inv.id, gateway: "stripe", externalId: intent.id, amount: intent.amount_received || due });
    await audit(null, "invoice.autocharged", "invoice", inv.id, { card: pm.last4 });
    return "paid";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(schema.invoices).set({ lastChargeError: message.slice(0, 300) }).where(eq(schema.invoices.id, inv.id));
    await audit(null, "invoice.autocharge_failed", "invoice", inv.id, { attempt, error: message.slice(0, 200) });
    return "failed";
  }
}

/** Cron: charges what is due for a (re)try. Idempotent within a day. */
export async function runAutoCharges(now = new Date()): Promise<{ paid: number; failed: number }> {
  const report = { paid: 0, failed: 0 };
  const gw = await getSettings("gateways");
  if (!gw.stripe.enabled || !gw.stripe.secretKey || !gw.stripe.saveCards) return report;
  const db = await getDb();
  const due = await db
    .select({ id: schema.invoices.id, attempts: schema.invoices.chargeAttempts, last: schema.invoices.lastChargeAt })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.status, "unpaid"), eq(schema.invoices.kind, "invoice"), eq(schema.invoices.chargePendingRef, ""), isNotNull(schema.invoices.companyId), lt(schema.invoices.chargeAttempts, CHARGE_RETRY_DAYS.length), or(isNull(schema.invoices.lastChargeAt), lt(schema.invoices.lastChargeAt, new Date(now.getTime() - DAY)))))
    .limit(200);
  for (const inv of due) {
    const wait = (CHARGE_RETRY_DAYS[inv.attempts] - (CHARGE_RETRY_DAYS[inv.attempts - 1] ?? 0)) * DAY;
    if (inv.last && now.getTime() - inv.last.getTime() < wait) continue;
    const outcome = await chargeInvoice(inv.id);
    if (outcome === "paid") report.paid++;
    else if (outcome === "failed") report.failed++;
  }
  return report;
}

/** The bank refused a debit started earlier (webhook): the invoice is free to be retried or paid by hand. */
export async function debitFailed(paymentIntentId: string, reason: string): Promise<void> {
  const db = await getDb();
  const [inv] = await db.update(schema.invoices).set({ chargePendingRef: "", lastChargeError: (reason || "The bank refused the debit").slice(0, 300) }).where(eq(schema.invoices.chargePendingRef, paymentIntentId)).returning({ id: schema.invoices.id });
  if (inv) await audit(null, "invoice.autocharge_failed", "invoice", inv.id, { error: reason.slice(0, 200) });
}
