import "server-only";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CYCLE_MONTHS } from "./format";

/** Business figures derived from services and invoices. No estimates: only what the database says. */

/** Recurring amount of a service brought to one month. One-off cycles count as zero. */
export const monthly = (amount: number, cycle: keyof typeof CYCLE_MONTHS) => (CYCLE_MONTHS[cycle] ? Math.round(amount / CYCLE_MONTHS[cycle]) : 0);

export async function revenueReport(now = new Date()) {
  const db = await getDb();
  const services = await db.select().from(schema.services).where(inArray(schema.services.status, ["active", "suspended", "terminated", "cancelled"]));
  const live = services.filter((s) => s.status === "active" || s.status === "suspended");
  const mrr = live.reduce((sum, s) => sum + monthly(s.amount, s.billingCycle), 0);
  const companies = new Set(live.map((s) => s.companyId ?? s.clientId));

  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const lost = services.filter((s) => (s.status === "terminated" || s.status === "cancelled") && s.updatedAt >= monthAgo);
  const gained = live.filter((s) => s.createdAt >= monthAgo);
  const churnedMrr = lost.reduce((sum, s) => sum + monthly(s.amount, s.billingCycle), 0);
  const newMrr = gained.reduce((sum, s) => sum + monthly(s.amount, s.billingCycle), 0);
  const startMrr = mrr - newMrr + churnedMrr;

  // Cash actually collected, month by month, for the last twelve.
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const tx = await db.select({ amount: schema.transactions.amount, at: schema.transactions.createdAt, gateway: schema.transactions.gateway }).from(schema.transactions).where(gte(schema.transactions.createdAt, from));
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    return { key: d.toISOString().slice(0, 7), collected: 0 };
  });
  // Credit is money that was already counted when it came in.
  for (const t of tx) if (t.gateway !== "credit") months.find((m) => m.key === t.at.toISOString().slice(0, 7))!.collected += t.amount;

  return { mrr, arr: mrr * 12, customers: companies.size, arpa: companies.size ? Math.round(mrr / companies.size) : 0, newMrr, churnedMrr, churnRate: startMrr > 0 ? churnedMrr / startMrr : 0, activeServices: live.length, months };
}

const csv = (v: unknown) => {
  const s = String(v ?? "");
  // Leading = + - @ would run as a formula in a spreadsheet: neutralise it.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Every document issued in a month (invoices and credit notes), one row each, for the accountant. */
export async function invoicesCsv(month: string, label: (inv: { number: number; fiscalYear: number }) => string): Promise<string> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid month");
  const [y, m] = month.split("-").map(Number);
  const db = await getDb();
  const rows = await db
    .select({ inv: schema.invoices, co: schema.companies, user: { email: schema.users.email, firstName: schema.users.firstName, lastName: schema.users.lastName } })
    .from(schema.invoices)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.invoices.companyId))
    .innerJoin(schema.users, eq(schema.users.id, schema.invoices.clientId))
    .where(and(gte(schema.invoices.createdAt, new Date(Date.UTC(y, m - 1, 1))), lt(schema.invoices.createdAt, new Date(Date.UTC(y, m, 1)))));
  const head = ["number", "type", "date", "status", "customer", "vat_id", "tax_code", "country", "currency", "net", "tax_rate", "tax", "total", "paid_on", "sdi_status"];
  const money = (c: number) => (c / 100).toFixed(2);
  const lines = rows
    .filter(({ inv }) => inv.status !== "draft" && inv.status !== "cancelled")
    .sort((a, b) => a.inv.fiscalYear - b.inv.fiscalYear || a.inv.number - b.inv.number)
    .map(({ inv, co, user }) => {
      const sign = inv.kind === "credit_note" ? -1 : 1;
      return [label(inv), inv.kind, inv.createdAt.toISOString().slice(0, 10), inv.status, co?.billingName || co?.name || `${user.firstName} ${user.lastName}`.trim() || user.email, co?.vatId, co?.taxCode, co?.country, inv.currency, money(sign * inv.subtotal), (inv.taxRate / 100).toFixed(2), money(sign * inv.tax), money(sign * inv.total), inv.paidAt?.toISOString().slice(0, 10), inv.sdiStatus].map(csv).join(",");
    });
  return [head.join(","), ...lines].join("\r\n");
}
