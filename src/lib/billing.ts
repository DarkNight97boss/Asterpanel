import "server-only";
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { BillingCycle } from "@/db/schema";
import { getProvisioningModule, type ProvisionContext } from "@/modules/provisioning";
import { audit } from "./audit";
import { decryptJson } from "./crypto";
import { addCycle, CYCLE_LABEL } from "./format";
import { getSettings } from "./settings";

const DAY = 86_400_000;

export class BillingError extends Error {}

const taxOn = (subtotal: number, rateBp: number) => Math.round((subtotal * rateBp) / 10_000);

// ─── Orders ──────────────────────────────────────────────────────────────────

export async function placeOrder(input: {
  clientId: string;
  productId: string;
  cycle: BillingCycle;
  domain: string;
  ip?: string;
}): Promise<{ orderId: string; invoiceId: string }> {
  const db = await getDb();
  const billing = await getSettings("billing");

  const product = await db.query.products.findFirst({ where: eq(schema.products.id, input.productId) });
  if (!product || product.hidden) throw new BillingError("Product not available");
  const price = product.pricing[input.cycle];
  if (typeof price !== "number") throw new BillingError("Billing cycle not available for this product");
  if (product.requiresDomain && !input.domain) throw new BillingError("A domain is required");

  const setup = product.pricing.setup ?? 0;
  const subtotal = price + setup;
  const tax = taxOn(subtotal, billing.taxRate);
  const total = subtotal + tax;

  const result = await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(schema.orders)
      .values({ clientId: input.clientId, total, ip: input.ip ?? "" })
      .returning();
    const [service] = await tx
      .insert(schema.services)
      .values({
        clientId: input.clientId,
        productId: product.id,
        orderId: order.id,
        serverId: product.serverId,
        domain: input.domain.toLowerCase(),
        billingCycle: input.cycle,
        amount: price,
      })
      .returning();
    const [invoice] = await tx
      .insert(schema.invoices)
      .values({
        clientId: input.clientId,
        currency: billing.currency,
        subtotal,
        taxRate: billing.taxRate,
        tax,
        total,
        dueDate: new Date(),
      })
      .returning();

    const label = `${product.name}${input.domain ? ` — ${input.domain}` : ""} (${CYCLE_LABEL[input.cycle]})`;
    await tx.insert(schema.invoiceItems).values([
      { invoiceId: invoice.id, serviceId: service.id, kind: "new" as const, description: label, amount: price },
      ...(setup > 0
        ? [{ invoiceId: invoice.id, serviceId: service.id, kind: "setup" as const, description: `${product.name} — setup fee`, amount: setup }]
        : []),
    ]);
    await tx.update(schema.orders).set({ invoiceId: invoice.id }).where(eq(schema.orders.id, order.id));
    return { orderId: order.id, invoiceId: invoice.id };
  });

  await audit(input.clientId, "order.placed", "order", result.orderId, { productId: product.id, total });
  if (total === 0) await recordPayment({ invoiceId: result.invoiceId, gateway: "free", externalId: "", amount: 0 });
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
    await fulfilInvoice(input.invoiceId);
  }
  return { paid: outcome.paid, duplicate: outcome.duplicate };
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
    } else if (item.kind === "renewal" && service.nextDueDate) {
      await db
        .update(schema.services)
        .set({ nextDueDate: addCycle(service.nextDueDate, service.billingCycle) })
        .where(eq(schema.services.id, service.id));
      if (service.status === "suspended" && service.suspendReason === OVERDUE) {
        await unsuspendService(service.id).catch(() => {});
      }
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

export type AutomationReport = { invoiced: number; suspended: number; terminated: number; errors: string[] };

/**
 * Daily billing run. Idempotent: running it twice in a row is a no-op the
 * second time, so an hourly schedule is perfectly fine.
 */
export async function runAutomation(now = new Date()): Promise<AutomationReport> {
  const db = await getDb();
  const billing = await getSettings("billing");
  const report: AutomationReport = { invoiced: 0, suspended: 0, terminated: 0, errors: [] };

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

  const byClient = Map.groupBy(due, (s) => s.clientId);
  for (const [clientId, list] of byClient) {
    try {
      await db.transaction(async (tx) => {
        const subtotal = list.reduce((sum, s) => sum + s.amount, 0);
        const tax = taxOn(subtotal, billing.taxRate);
        const dueDate = new Date(Math.min(...list.map((s) => s.nextDueDate!.getTime())));
        const [invoice] = await tx
          .insert(schema.invoices)
          .values({ clientId, currency: billing.currency, subtotal, taxRate: billing.taxRate, tax, total: subtotal + tax, dueDate })
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
      });
      report.invoiced++;
    } catch (err) {
      report.errors.push(`invoice client ${clientId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 2. Suspend services whose due date passed the grace period.
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

  // 3. Terminate long-overdue suspended services (0 disables).
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
