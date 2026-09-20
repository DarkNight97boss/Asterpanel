import "server-only";
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { makeT } from "@/i18n/shared";
import type { BillingCycle } from "@/db/schema";
import { getProvisioningModule, type ProvisionContext } from "@/modules/provisioning";
import { audit } from "./audit";
import { taxFor } from "./tax";
import { emitEvent } from "./webhooks";
import { decryptJson } from "./crypto";
import { addCycle, CYCLE_LABEL, CYCLE_MONTHS, invoiceLabel } from "./format";
import { mailConfigured } from "./mail/transport";
import { notify } from "./notify";
import { getSettings } from "./settings";

const DAY = 86_400_000;

export class BillingError extends Error {}

const taxOn = (subtotal: number, rateBp: number) => Math.round((subtotal * rateBp) / 10_000);

// ─── Invoice numbering ───────────────────────────────────────────────────────

type Tx = Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0];

/**
 * Next invoice number of the fiscal year: progressive and without gaps, as
 * tax rules require. The counter row is updated in the same transaction that
 * inserts the invoice — it serialises concurrent issuers and, if anything
 * fails, the rollback gives the number back.
 */
async function nextInvoiceNumber(tx: Tx, issuedAt = new Date()): Promise<{ number: number; fiscalYear: number }> {
  const fiscalYear = issuedAt.getUTCFullYear();
  const [row] = await tx
    .insert(schema.counters)
    .values({ key: `invoice:${fiscalYear}`, value: 1 })
    .onConflictDoUpdate({ target: schema.counters.key, set: { value: sql`${schema.counters.value} + 1` } })
    .returning({ value: schema.counters.value });
  return { number: row.value, fiscalYear };
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export async function placeOrder(input: {
  clientId: string;
  /** The company that owns the order; `clientId` stays the person it is addressed to. */
  companyId?: string | null;
  productId: string;
  cycle: BillingCycle;
  domain: string;
  ip?: string;
  /** Ids of the product's add-ons chosen with the order. */
  addonIds?: string[];
  /** Discount code for the first invoice. An unusable code refuses the order instead of silently charging full price. */
  coupon?: string;
  /** Price decided by the caller instead of the catalogue (domains: per-TLD register / renew prices). */
  pricing?: { first: number; recurring: number; label: string; /** Shown instead of "1 year". */ period?: string };
  /** Module-specific order options, stored as `service.moduleData.request`. */
  request?: Record<string, unknown>;
}): Promise<{ orderId: string; invoiceId: string; serviceId: string }> {
  const db = await getDb();
  const billing = await getSettings("billing");
  const t = makeT((await getSettings("general")).locale);

  const product = await db.query.products.findFirst({ where: eq(schema.products.id, input.productId) });
  // Hidden products are system entries, only orderable with a price from the caller.
  if (!product || (product.hidden && !input.pricing)) throw new BillingError("Product not available");
  const listPrice = input.pricing?.first ?? product.pricing[input.cycle];
  if (typeof listPrice !== "number") throw new BillingError("Billing cycle not available for this product");
  // Add-ons are priced per month and billed with the plan's cycle.
  const addons = input.pricing ? [] : product.addons.filter((a) => input.addonIds?.includes(a.id));
  if (addons.length !== new Set(input.addonIds ?? []).size && !input.pricing) throw new BillingError("An add-on is no longer available");
  const months = CYCLE_MONTHS[input.cycle] || 1;
  const addonsPrice = addons.reduce((sum, a) => sum + a.monthly * months, 0);
  // A company's own price list (resellers, agencies) applies to catalogue prices, never to caller-decided ones (domains).
  const listDiscount = input.pricing || !input.companyId ? 0 : ((await db.select({ p: schema.companies.discountPercent }).from(schema.companies).where(eq(schema.companies.id, input.companyId)))[0]?.p ?? 0);
  const price = Math.round(((listPrice + addonsPrice) * (100 - Math.min(90, Math.max(0, listDiscount)))) / 100);
  if (product.requiresDomain && !input.domain) throw new BillingError("A domain is required");

  const setup = input.pricing ? 0 : (product.pricing.setup ?? 0);
  const code = (input.coupon ?? "").trim().toUpperCase();
  const coupon = code ? await usableCoupon(code) : null;
  const discount = coupon ? Math.min(price + setup, coupon.kind === "percent" ? Math.round(((price + setup) * coupon.value) / 100) : coupon.value) : 0;
  const subtotal = price + setup - discount;
  const vat = await taxFor(input.companyId);
  const tax = taxOn(subtotal, vat.rate);
  const total = subtotal + tax;

  const result = await db.transaction(async (tx) => {
    if (coupon) {
      // Claimed inside the order transaction: the last use cannot be taken twice, and a failed order gives it back.
      const [claimed] = await tx.update(schema.coupons).set({ used: sql`${schema.coupons.used} + 1` }).where(and(eq(schema.coupons.id, coupon.id), or(eq(schema.coupons.maxUses, 0), lt(schema.coupons.used, schema.coupons.maxUses)))).returning({ id: schema.coupons.id });
      if (!claimed) throw new BillingError("This discount code has been used up");
    }
    const [order] = await tx
      .insert(schema.orders)
      .values({ clientId: input.clientId, companyId: input.companyId ?? null, total, ip: input.ip ?? "" })
      .returning();
    const [service] = await tx
      .insert(schema.services)
      .values({
        clientId: input.clientId,
        companyId: input.companyId ?? null,
        productId: product.id,
        orderId: order.id,
        serverId: product.serverId,
        domain: input.domain.toLowerCase(),
        billingCycle: input.cycle,
        amount: input.pricing?.recurring ?? price,
        moduleData: { ...(input.request ? { request: input.request } : {}), ...(addons.length ? { addons } : {}) },
      })
      .returning();
    const [invoice] = await tx
      .insert(schema.invoices)
      .values({
        ...(await nextInvoiceNumber(tx)),
        clientId: input.clientId,
        companyId: input.companyId ?? null,
        currency: billing.currency,
        subtotal,
        taxRate: vat.rate,
        notes: vat.note,
        tax,
        total,
        dueDate: new Date(),
      })
      .returning();

    // Invoice lines are a legal record: written once, in the site language.
    const extras = addons.length ? ` + ${addons.map((a) => a.name).join(", ")}` : "";
    const label = input.pricing ? `${t(input.pricing.label)} — ${input.domain} (${t(input.pricing.period ?? "1 year")})` : `${product.name}${extras}${input.domain ? ` — ${input.domain}` : ""} (${t(CYCLE_LABEL[input.cycle])})`;
    await tx.insert(schema.invoiceItems).values([
      { invoiceId: invoice.id, serviceId: service.id, kind: "new" as const, description: label, amount: price },
      ...(setup > 0
        ? [{ invoiceId: invoice.id, serviceId: service.id, kind: "setup" as const, description: `${product.name} — ${t("Setup fee")}`, amount: setup }]
        : []),
      ...(discount > 0 ? [{ invoiceId: invoice.id, serviceId: null, kind: "discount" as const, description: `${t("Discount code")} ${coupon!.code}`, amount: -discount }] : []),
    ]);
    await tx.update(schema.orders).set({ invoiceId: invoice.id }).where(eq(schema.orders.id, order.id));
    return { orderId: order.id, invoiceId: invoice.id, serviceId: service.id };
  });

  await audit(input.clientId, "order.placed", "order", result.orderId, { productId: product.id, total });
  if (total === 0) await recordPayment({ invoiceId: result.invoiceId, gateway: "free", externalId: "", amount: 0 });
  else {
    await applyCredit(result.invoiceId);
    notify.invoiceCreated(result.invoiceId);
  }
  emitEvent(input.companyId, "invoice.created", { invoiceId: result.invoiceId, total, currency: billing.currency });
  return result;
}

/**
 * Several caller-priced services of one product on a single order and invoice
 * (a basket of domains). Each line becomes its own service, so every domain
 * is provisioned, renewed and cancelled by itself afterwards.
 */
export async function placeBundle(input: {
  clientId: string;
  companyId?: string | null;
  productId: string;
  cycle: BillingCycle;
  ip?: string;
  lines: { domain: string; pricing: { first: number; recurring: number; label: string; period?: string }; request?: Record<string, unknown> }[];
}): Promise<{ orderId: string; invoiceId: string; serviceIds: string[] }> {
  if (!input.lines.length || input.lines.length > 50) throw new BillingError("Nothing to order");
  const db = await getDb();
  const billing = await getSettings("billing");
  const t = makeT((await getSettings("general")).locale);
  const product = await db.query.products.findFirst({ where: eq(schema.products.id, input.productId) });
  if (!product) throw new BillingError("Product not available");
  const subtotal = input.lines.reduce((sum, l) => sum + l.pricing.first, 0);
  // Looked up before the transaction: the embedded database has one connection.
  const vat = await taxFor(input.companyId);
  const tax = taxOn(subtotal, vat.rate);
  const total = subtotal + tax;

  const result = await db.transaction(async (tx) => {
    const [order] = await tx.insert(schema.orders).values({ clientId: input.clientId, companyId: input.companyId ?? null, total, ip: input.ip ?? "" }).returning();
    const [invoice] = await tx
      .insert(schema.invoices)
      .values({ ...(await nextInvoiceNumber(tx)), clientId: input.clientId, companyId: input.companyId ?? null, currency: billing.currency, subtotal, taxRate: vat.rate, notes: vat.note, tax, total, dueDate: new Date() })
      .returning();
    const serviceIds: string[] = [];
    for (const line of input.lines) {
      const [service] = await tx
        .insert(schema.services)
        .values({ clientId: input.clientId, companyId: input.companyId ?? null, productId: product.id, orderId: order.id, serverId: product.serverId, domain: line.domain.toLowerCase(), billingCycle: input.cycle, amount: line.pricing.recurring, moduleData: line.request ? { request: line.request } : {} })
        .returning({ id: schema.services.id });
      serviceIds.push(service.id);
      await tx.insert(schema.invoiceItems).values({ invoiceId: invoice.id, serviceId: service.id, kind: "new", description: `${t(line.pricing.label)} — ${line.domain} (${t(line.pricing.period ?? "1 year")})`, amount: line.pricing.first });
    }
    await tx.update(schema.orders).set({ invoiceId: invoice.id }).where(eq(schema.orders.id, order.id));
    return { orderId: order.id, invoiceId: invoice.id, serviceIds };
  });

  await audit(input.clientId, "order.placed", "order", result.orderId, { productId: product.id, total, lines: input.lines.length });
  if (total === 0) await recordPayment({ invoiceId: result.invoiceId, gateway: "free", externalId: "", amount: 0 });
  else {
    await applyCredit(result.invoiceId);
    notify.invoiceCreated(result.invoiceId);
  }
  emitEvent(input.companyId, "invoice.created", { invoiceId: result.invoiceId, total, currency: billing.currency });
  return result;
}

// ─── Payments ────────────────────────────────────────────────────────────────

/**
 * The only path that turns an invoice into "paid". Safe to call more than
 * once for the same gateway reference (webhooks are delivered at-least-once).
 */
export async function recordPayment(input: {
  invoiceId: string;
  gateway: string;
  externalId: string;
  amount: number;
  actorId?: string | null;
}): Promise<{ paid: boolean; duplicate: boolean }> {
  const db = await getDb();

  const outcome = await db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
    if (!invoice) throw new BillingError("Invoice not found");

    if (input.externalId) {
      const [dupe] = await tx
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(and(eq(schema.transactions.gateway, input.gateway), eq(schema.transactions.externalId, input.externalId)))
        .limit(1);
      if (dupe) return { paid: invoice.status === "paid", duplicate: true, becamePaid: false };
    }

    if (input.amount > 0 || input.gateway !== "free") {
      await tx.insert(schema.transactions).values({
        invoiceId: invoice.id,
        clientId: invoice.clientId,
        gateway: input.gateway,
        externalId: input.externalId,
        amount: input.amount,
      });
    }

    const [{ sum }] = await tx
      .select({ sum: sql<number>`coalesce(sum(${schema.transactions.amount}), 0)::int` })
      .from(schema.transactions)
      .where(eq(schema.transactions.invoiceId, invoice.id));

    const becamePaid = invoice.status === "unpaid" && sum >= invoice.total;
    if (becamePaid) {
      await tx.update(schema.invoices).set({ status: "paid", paidAt: new Date() }).where(eq(schema.invoices.id, invoice.id));
    }
    return { paid: becamePaid || invoice.status === "paid", duplicate: false, becamePaid };
  });

  if (outcome.becamePaid) {
    await audit(input.actorId ?? null, "invoice.paid", "invoice", input.invoiceId, { gateway: input.gateway });
    if (input.gateway !== "free") notify.invoicePaid(input.invoiceId);
    const [paid] = await db.select({ companyId: schema.invoices.companyId, total: schema.invoices.total, currency: schema.invoices.currency }).from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId));
    emitEvent(paid?.companyId, "invoice.paid", { invoiceId: input.invoiceId, total: paid?.total, currency: paid?.currency });
    await fulfilInvoice(input.invoiceId);
    await (await import("./referrals")).payReferralCommission(input.invoiceId).catch(() => 0);
    // Lazy import: e-invoicing loads the invoice through modules that import billing.
    await (await import("./sdi")).autoSendToSdi(input.invoiceId);
  }
  return { paid: outcome.paid, duplicate: outcome.duplicate };
}

/**
 * Reverses a paid invoice in full with a credit note (a document of its own in
 * the same numbering series) and marks the invoice refunded. Bookkeeping only:
 * the money itself is sent back from the gateway's dashboard.
 */
export async function issueCreditNote(invoiceId: string, reason: string, actorId: string | null = null): Promise<string> {
  const db = await getDb();
  const t = makeT((await getSettings("general")).locale);
  const prefix = (await getSettings("billing")).invoicePrefix;
  const creditId = await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).for("update");
    if (!inv || inv.kind !== "invoice") throw new BillingError("Invoice not found");
    if (inv.status !== "paid") throw new BillingError("Only paid invoices can be credited; cancel an unpaid one instead");
    const items = await tx.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, inv.id));
    const [credit] = await tx
      .insert(schema.invoices)
      .values({ ...(await nextInvoiceNumber(tx)), kind: "credit_note", creditsInvoiceId: inv.id, clientId: inv.clientId, companyId: inv.companyId, status: "paid", paidAt: new Date(), currency: inv.currency, subtotal: inv.subtotal, taxRate: inv.taxRate, tax: inv.tax, total: inv.total, dueDate: new Date(), notes: `${t("Credit note for invoice {number}", { number: invoiceLabel(prefix, inv) })}${reason ? ` — ${reason.slice(0, 300)}` : ""}` })
      .returning({ id: schema.invoices.id });
    // Lines are copied without their service link: a credit note never activates or renews anything.
    await tx.insert(schema.invoiceItems).values(items.map((i) => ({ invoiceId: credit.id, kind: "custom" as const, description: i.description, amount: i.amount })));
    await tx.update(schema.invoices).set({ status: "refunded" }).where(eq(schema.invoices.id, inv.id));
    return credit.id;
  });
  await audit(actorId, "invoice.credited", "invoice", invoiceId, { creditNoteId: creditId });
  return creditId;
}

// ─── One-off invoices ────────────────────────────────────────────────────────

/** An invoice for work that is not a catalogue service (a migration, an hour of consulting, an accepted quote). */
export async function createCustomInvoice(input: { clientId: string; companyId: string | null; items: { description: string; amount: number }[]; notes?: string; dueInDays?: number; actorId?: string | null }): Promise<string> {
  const items = input.items.filter((i) => i.description.trim() && Number.isInteger(i.amount) && i.amount !== 0).slice(0, 50);
  const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
  if (!items.length || subtotal <= 0) throw new BillingError("Add at least one line with an amount");
  const db = await getDb();
  const billing = await getSettings("billing");
  // Before the transaction: see taxFor's note about the single database connection.
  const vat = await taxFor(input.companyId);
  const tax = taxOn(subtotal, vat.rate);
  const invoiceId = await db.transaction(async (tx) => {
    const [inv] = await tx.insert(schema.invoices).values({ ...(await nextInvoiceNumber(tx)), clientId: input.clientId, companyId: input.companyId, currency: billing.currency, subtotal, taxRate: vat.rate, tax, total: subtotal + tax, notes: [input.notes?.trim(), vat.note].filter(Boolean).join("\n\n"), dueDate: new Date(Date.now() + (input.dueInDays ?? 0) * 86_400_000) }).returning({ id: schema.invoices.id });
    await tx.insert(schema.invoiceItems).values(items.map((i) => ({ invoiceId: inv.id, kind: "custom" as const, description: i.description.trim().slice(0, 500), amount: i.amount })));
    return inv.id;
  });
  await audit(input.actorId ?? null, "invoice.created", "invoice", invoiceId, { subtotal });
  await applyCredit(invoiceId);
  if ((await invoiceDue(invoiceId)) > 0) notify.invoiceCreated(invoiceId);
  emitEvent(input.companyId, "invoice.created", { invoiceId, total: subtotal + tax, currency: billing.currency });
  return invoiceId;
}

// ─── Plan changes ────────────────────────────────────────────────────────────

/** Share of the current billing period that is still ahead, between 0 and 1. */
export function remainingFraction(nextDue: Date, cycle: BillingCycle, now = new Date()): number {
  const months = CYCLE_MONTHS[cycle];
  if (!months) return 0;
  const start = new Date(nextDue);
  start.setUTCMonth(start.getUTCMonth() - months);
  const total = nextDue.getTime() - start.getTime();
  return total <= 0 ? 0 : Math.min(1, Math.max(0, (nextDue.getTime() - now.getTime()) / total));
}

/** Products a service can move to: same group and module, same kind of workload, priced for the same cycle. */
export async function planOptions(serviceId: string) {
  const db = await getDb();
  const svc = await db.query.services.findFirst({ where: eq(schema.services.id, serviceId), with: { product: true } });
  if (!svc) return [];
  const siblings = await db.select().from(schema.products).where(and(eq(schema.products.groupId, svc.product.groupId), eq(schema.products.module, svc.product.module), eq(schema.products.hidden, false)));
  return siblings.filter((p) => p.id !== svc.productId && typeof p.pricing[svc.billingCycle] === "number" && (p.moduleConfig.type ?? "") === (svc.product.moduleConfig.type ?? ""));
}

async function applyPlan(serviceId: string, productId: string, amount: number, actorId: string | null) {
  const db = await getDb();
  const [svc] = await db.select({ moduleData: schema.services.moduleData }).from(schema.services).where(eq(schema.services.id, serviceId));
  const { pendingPlan: _done, ...moduleData } = (svc?.moduleData ?? {}) as Record<string, unknown>;
  void _done;
  await db.update(schema.services).set({ productId, amount, moduleData }).where(eq(schema.services.id, serviceId));
  const ctx = await contextFor(serviceId);
  // The customer already has (and paid for) the new plan: a module error is logged for staff, not thrown.
  await getProvisioningModule(ctx.product.module)
    .changePlan?.(ctx)
    .catch((err: unknown) => audit(null, "service.plan_change.failed", "service", serviceId, { error: err instanceof Error ? err.message : String(err) }));
  await audit(actorId, "service.plan_changed", "service", serviceId, { productId, amount });
}

/**
 * Moves a service to another plan, pro-rated on the time left in the period.
 * Upgrade: an invoice for the difference, and the new plan starts when it is
 * paid. Downgrade: immediate, the difference goes to the company's credit.
 */
export async function changePlan(serviceId: string, productId: string, actorId: string | null = null, now = new Date()): Promise<{ invoiceId: string | null; credited: number }> {
  const db = await getDb();
  const svc = await db.query.services.findFirst({ where: eq(schema.services.id, serviceId), with: { product: true } });
  if (!svc || svc.status !== "active" || !svc.nextDueDate) throw new BillingError("Only active services can change plan");
  const target = (await planOptions(serviceId)).find((p) => p.id === productId);
  if (!target) throw new BillingError("This plan is not available for this service");
  const pending = (svc.moduleData as { pendingPlan?: { invoiceId: string } }).pendingPlan;
  if (pending) {
    // A cancelled upgrade invoice frees the service for another change.
    const [open] = await db.select({ status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, pending.invoiceId));
    if (open?.status === "unpaid") throw new BillingError("A plan change is already waiting for payment");
  }

  // Same rules as at order time: the add-ons the service carries, then the company's price list.
  const carried = (Array.isArray(svc.moduleData.addons) ? svc.moduleData.addons : []) as { monthly?: number }[];
  const months = CYCLE_MONTHS[svc.billingCycle] || 1;
  const listDiscount = svc.companyId ? ((await db.select({ p: schema.companies.discountPercent }).from(schema.companies).where(eq(schema.companies.id, svc.companyId)))[0]?.p ?? 0) : 0;
  const price = Math.round(((target.pricing[svc.billingCycle]! + carried.reduce((sum, a) => sum + (Number(a.monthly) || 0) * months, 0)) * (100 - Math.min(90, Math.max(0, listDiscount)))) / 100);
  const prorated = Math.round((price - svc.amount) * remainingFraction(svc.nextDueDate, svc.billingCycle, now));
  if (prorated <= 0) {
    await applyPlan(svc.id, target.id, price, actorId);
    if (prorated < 0 && svc.companyId) await adjustCredit(svc.companyId, -prorated, `Downgrade to ${target.name}`, actorId);
    return { invoiceId: null, credited: svc.companyId ? -prorated : 0 };
  }

  const billing = await getSettings("billing");
  const t = makeT((await getSettings("general")).locale);
  const vat = await taxFor(svc.companyId);
  const tax = taxOn(prorated, vat.rate);
  const invoiceId = await db.transaction(async (tx) => {
    const [invoice] = await tx.insert(schema.invoices).values({ ...(await nextInvoiceNumber(tx)), clientId: svc.clientId, companyId: svc.companyId, currency: billing.currency, subtotal: prorated, taxRate: vat.rate, notes: vat.note, tax, total: prorated + tax, dueDate: now }).returning({ id: schema.invoices.id });
    await tx.insert(schema.invoiceItems).values({ invoiceId: invoice.id, serviceId: svc.id, kind: "upgrade", description: `${t("Upgrade")}: ${svc.product.name} → ${target.name}`, amount: prorated });
    await tx.update(schema.services).set({ moduleData: { ...svc.moduleData, pendingPlan: { productId: target.id, amount: price, invoiceId: invoice.id } } }).where(eq(schema.services.id, svc.id));
    return invoice.id;
  });
  await audit(actorId, "service.upgrade_ordered", "service", svc.id, { productId: target.id, prorated });
  await applyCredit(invoiceId);
  if ((await invoiceDue(invoiceId)) > 0) notify.invoiceCreated(invoiceId);
  return { invoiceId, credited: 0 };
}

// ─── Prepaid credit ──────────────────────────────────────────────────────────

/** What is still to pay on an invoice, after partial payments and credit. */
export async function invoiceDue(invoiceId: string): Promise<number> {
  const db = await getDb();
  const [inv] = await db.select({ total: schema.invoices.total, status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv || inv.status !== "unpaid") return 0;
  const [{ paid }] = await db.select({ paid: sql<number>`coalesce(sum(${schema.transactions.amount}), 0)::int` }).from(schema.transactions).where(eq(schema.transactions.invoiceId, invoiceId));
  return Math.max(0, inv.total - paid);
}

/** Adds (or, with a negative amount, removes) prepaid credit. The balance can never go below zero. */
export async function adjustCredit(companyId: string, amount: number, reason: string, actorId: string | null = null, invoiceId: string | null = null): Promise<number> {
  if (!Number.isInteger(amount) || amount === 0) throw new BillingError("Enter an amount");
  const db = await getDb();
  const balance = await db.transaction(async (tx) => {
    const [co] = await tx.update(schema.companies).set({ creditBalance: sql`${schema.companies.creditBalance} + ${amount}` }).where(and(eq(schema.companies.id, companyId), sql`${schema.companies.creditBalance} + ${amount} >= 0`)).returning({ balance: schema.companies.creditBalance });
    if (!co) throw new BillingError("The company does not have that much credit");
    await tx.insert(schema.creditLedger).values({ companyId, amount, reason: reason.slice(0, 200), actorId, invoiceId });
    return co.balance;
  });
  await audit(actorId, "credit.adjusted", "company", companyId, { amount, reason: reason.slice(0, 100) });
  return balance;
}

/** Spends the company's credit on an unpaid invoice. Safe to call more than once. */
export async function applyCredit(invoiceId: string): Promise<number> {
  const db = await getDb();
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv?.companyId || inv.status !== "unpaid" || inv.kind !== "invoice") return 0;
  const due = await invoiceDue(invoiceId);
  const [co] = await db.select({ balance: schema.companies.creditBalance }).from(schema.companies).where(eq(schema.companies.id, inv.companyId));
  const spend = Math.min(due, co?.balance ?? 0);
  if (spend <= 0) return 0;
  try {
    await adjustCredit(inv.companyId, -spend, "Applied to invoice", null, inv.id);
  } catch {
    return 0; // spent meanwhile by a concurrent invoice
  }
  // One credit payment per ledger movement: the id makes a retry harmless.
  await recordPayment({ invoiceId, gateway: "credit", externalId: `credit-${invoiceId}-${Date.now()}`, amount: spend });
  return spend;
}

/** The coupon behind a code if it can be used right now; throws a message for the customer otherwise. */
export async function usableCoupon(code: string) {
  const db = await getDb();
  const [c] = await db.select().from(schema.coupons).where(eq(schema.coupons.code, code.trim().toUpperCase()));
  if (!c || !c.enabled) throw new BillingError("This discount code is not valid");
  if (c.expiresAt && c.expiresAt < new Date()) throw new BillingError("This discount code has expired");
  if (c.maxUses > 0 && c.used >= c.maxUses) throw new BillingError("This discount code has been used up");
  return c;
}

/** Applies the effects of a paid invoice to the services it bills. */
async function fulfilInvoice(invoiceId: string) {
  const db = await getDb();
  const items = await db
    .select()
    .from(schema.invoiceItems)
    .where(and(eq(schema.invoiceItems.invoiceId, invoiceId), isNotNull(schema.invoiceItems.serviceId)));

  for (const item of items) {
    const service = await db.query.services.findFirst({ where: eq(schema.services.id, item.serviceId!) });
    if (!service) continue;

    if (item.kind === "new" && service.status === "pending") {
      await db
        .update(schema.services)
        .set({ nextDueDate: addCycle(new Date(), service.billingCycle) })
        .where(eq(schema.services.id, service.id));
      if (service.orderId) {
        await db.update(schema.orders).set({ status: "active" }).where(eq(schema.orders.id, service.orderId));
      }
      // A provisioning failure must not un-pay the invoice: the service stays
      // pending and shows up in the admin queue for a retry.
      await activateService(service.id).catch(() => {});
    } else if (item.kind === "upgrade") {
      const pending = (service.moduleData as { pendingPlan?: { productId: string; amount: number; invoiceId: string } }).pendingPlan;
      if (pending?.invoiceId === invoiceId) await applyPlan(service.id, pending.productId, pending.amount, null);
    } else if (item.kind === "renewal" && service.nextDueDate) {
      await db
        .update(schema.services)
        .set({ nextDueDate: addCycle(service.nextDueDate, service.billingCycle) })
        .where(eq(schema.services.id, service.id));
      if (service.status === "suspended" && service.suspendReason === OVERDUE) {
        await unsuspendService(service.id).catch(() => {});
      }
      // Same rule as activation: a failing module never un-pays the invoice.
      const ctx = await contextFor(service.id);
      await getProvisioningModule(ctx.product.module)
        .renew?.(ctx)
        .catch((err: unknown) => audit(null, "service.renew.failed", "service", service.id, { error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

// ─── Service lifecycle ───────────────────────────────────────────────────────

const OVERDUE = "Overdue on payment";

async function contextFor(serviceId: string): Promise<ProvisionContext> {
  const db = await getDb();
  const service = await db.query.services.findFirst({
    where: eq(schema.services.id, serviceId),
    with: { product: true, client: true, server: true },
  });
  if (!service) throw new BillingError("Service not found");
  const { product, client, server, ...row } = service;
  return {
    service: row,
    product,
    client,
    server: server && {
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      credentials: decryptJson<Record<string, string>>(server.credentials, {}),
    },
  };
}

async function lifecycle(
  serviceId: string,
  action: "create" | "suspend" | "unsuspend" | "terminate",
  actorId: string | null,
  reason = "",
): Promise<string | undefined> {
  const db = await getDb();
  const ctx = await contextFor(serviceId);
  const mod = getProvisioningModule(ctx.product.module);
  if (mod.requiresServer && !ctx.server) throw new BillingError(`Module “${mod.name}” needs a server assigned`);

  try {
    let message: string | undefined;
    if (action === "create") {
      const res = await mod.create(ctx);
      message = res.message;
      await db
        .update(schema.services)
        .set({
          status: "active",
          suspendReason: "",
          username: res.username ?? ctx.service.username,
          moduleData: { ...ctx.service.moduleData, ...res.moduleData },
        })
        .where(eq(schema.services.id, serviceId));
    } else if (action === "suspend") {
      await mod.suspend(ctx, reason);
      await db.update(schema.services).set({ status: "suspended", suspendReason: reason }).where(eq(schema.services.id, serviceId));
    } else if (action === "unsuspend") {
      await mod.unsuspend(ctx);
      await db.update(schema.services).set({ status: "active", suspendReason: "" }).where(eq(schema.services.id, serviceId));
    } else {
      await mod.terminate(ctx);
      await db.update(schema.services).set({ status: "terminated", nextDueDate: null }).where(eq(schema.services.id, serviceId));
    }
    await audit(actorId, `service.${action}`, "service", serviceId, { module: mod.id });
    if (action === "create") notify.serviceActivated(serviceId, message);
    else if (action === "suspend") notify.serviceSuspended(serviceId, reason);
    else if (action === "unsuspend") notify.serviceUnsuspended(serviceId);
    else notify.serviceTerminated(serviceId);
    return message;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit(actorId, `service.${action}.failed`, "service", serviceId, { module: mod.id, error: message });
    throw err;
  }
}

export const activateService = (id: string, actorId: string | null = null) => lifecycle(id, "create", actorId);
export const suspendService = (id: string, reason: string, actorId: string | null = null) =>
  lifecycle(id, "suspend", actorId, reason);
export const unsuspendService = (id: string, actorId: string | null = null) => lifecycle(id, "unsuspend", actorId);
export const terminateService = (id: string, actorId: string | null = null) => lifecycle(id, "terminate", actorId);

// ─── Automation (cron) ───────────────────────────────────────────────────────

export type AutomationReport = { invoiced: number; reminded: number; suspended: number; terminated: number; errors: string[] };

/**
 * Daily billing run. Idempotent: running it twice in a row is a no-op the
 * second time, so an hourly schedule is perfectly fine.
 */
export async function runAutomation(now = new Date()): Promise<AutomationReport> {
  const db = await getDb();
  const billing = await getSettings("billing");
  const report: AutomationReport = { invoiced: 0, reminded: 0, suspended: 0, terminated: 0, errors: [] };

  // 1. Renewal invoices — one per client, grouping everything coming due.
  const horizon = new Date(now.getTime() + billing.invoiceDaysBeforeDue * DAY);
  const due = await db.query.services.findMany({
    where: and(
      inArray(schema.services.status, ["active", "suspended"]),
      lte(schema.services.nextDueDate, horizon),
      or(isNull(schema.services.renewalInvoicedFor), lt(schema.services.renewalInvoicedFor, schema.services.nextDueDate)),
    ),
    with: { product: true },
  });

  // One renewal invoice per company (legacy services without one fall back to the person).
  const byClient = Map.groupBy(due, (s) => s.companyId ?? s.clientId);
  for (const [, list] of byClient) {
    const clientId = list[0].clientId;
    try {
      // Looked up before the transaction: the embedded database has a single connection, and a query
      // outside the transaction while it is open would wait for itself forever.
      const vat = await taxFor(list[0].companyId);
      const invoiceId = await db.transaction(async (tx) => {
        const subtotal = list.reduce((sum, s) => sum + s.amount, 0);
        const tax = taxOn(subtotal, vat.rate);
        const dueDate = new Date(Math.min(...list.map((s) => s.nextDueDate!.getTime())));
        const [invoice] = await tx
          .insert(schema.invoices)
          .values({ ...(await nextInvoiceNumber(tx, now)), clientId, companyId: list[0].companyId, currency: billing.currency, subtotal, taxRate: vat.rate, notes: vat.note, tax, total: subtotal + tax, dueDate })
          .returning();
        await tx.insert(schema.invoiceItems).values(
          list.map((s) => ({
            invoiceId: invoice.id,
            serviceId: s.id,
            kind: "renewal" as const,
            description: `${s.product.name}${s.domain ? ` — ${s.domain}` : ""} (${s.nextDueDate!.toISOString().slice(0, 10)} → ${addCycle(s.nextDueDate!, s.billingCycle)?.toISOString().slice(0, 10)})`,
            amount: s.amount,
          })),
        );
        for (const s of list) {
          await tx.update(schema.services).set({ renewalInvoicedFor: s.nextDueDate }).where(eq(schema.services.id, s.id));
        }
        return invoice.id;
      });
      await applyCredit(invoiceId);
      notify.invoiceCreated(invoiceId);
      emitEvent(list[0].companyId, "invoice.created", { invoiceId, renewal: true });
      report.invoiced++;
    } catch (err) {
      report.errors.push(`invoice client ${clientId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 2. Overdue reminders. `remindersSent` counts the thresholds already
  //    handled, so each one fires once and a missed day is caught up with a
  //    single email rather than a burst.
  const thresholds = [...billing.overdueReminderDays].sort((a, b) => a - b);
  // Without a working mailer nothing is consumed: reminders start (with one
  // catch-up email per invoice) as soon as email is configured.
  if (thresholds.length && mailConfigured(await getSettings("mail"))) {
    const overdue = await db
      .select({ id: schema.invoices.id, dueDate: schema.invoices.dueDate, remindersSent: schema.invoices.remindersSent })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.status, "unpaid"),
          gt(schema.invoices.total, 0),
          lt(schema.invoices.dueDate, new Date(now.getTime() - thresholds[0] * DAY)),
          lt(schema.invoices.remindersSent, thresholds.length),
        ),
      );
    for (const invoice of overdue) {
      const daysLate = Math.floor((now.getTime() - invoice.dueDate.getTime()) / DAY);
      const reached = thresholds.filter((d) => d <= daysLate).length;
      if (reached <= invoice.remindersSent) continue;
      await db.update(schema.invoices).set({ remindersSent: reached }).where(eq(schema.invoices.id, invoice.id));
      notify.invoiceReminder(invoice.id);
      report.reminded++;
    }
  }

  // 3. Suspend services whose due date passed the grace period.
  const suspendBefore = new Date(now.getTime() - billing.suspendDaysAfterDue * DAY);
  const toSuspend = await db
    .select({ id: schema.services.id })
    .from(schema.services)
    .where(and(eq(schema.services.status, "active"), lt(schema.services.nextDueDate, suspendBefore)));
  for (const { id } of toSuspend) {
    try {
      await suspendService(id, OVERDUE);
      report.suspended++;
    } catch (err) {
      report.errors.push(`suspend ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 4. Terminate long-overdue suspended services (0 disables).
  if (billing.terminateDaysAfterDue > 0) {
    const terminateBefore = new Date(now.getTime() - billing.terminateDaysAfterDue * DAY);
    const toTerminate = await db
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(
        and(
          eq(schema.services.status, "suspended"),
          eq(schema.services.suspendReason, OVERDUE),
          lt(schema.services.nextDueDate, terminateBefore),
        ),
      );
    for (const { id } of toTerminate) {
      try {
        await terminateService(id);
        report.terminated++;
      } catch (err) {
        report.errors.push(`terminate ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  await audit(null, "automation.run", "", "", report);
  return report;
}
