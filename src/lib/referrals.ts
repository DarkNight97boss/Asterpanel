import "server-only";
import { and, eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { randomToken } from "./crypto";
import { getSettings } from "./settings";

/** Referral programme: commissions are paid as account credit, never as cash. */

export const REFERRAL_CODE = /^[A-Z0-9]{6,12}$/;

/** The company's code, created the first time it is asked for. */
export async function referralCodeOf(companyId: string): Promise<string> {
  const db = await getDb();
  const [co] = await db.select({ code: schema.companies.referralCode }).from(schema.companies).where(eq(schema.companies.id, companyId));
  if (co?.code) return co.code;
  for (let i = 0; i < 5; i++) {
    const code = randomToken(9).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8).padEnd(8, "X");
    const [set] = await db.update(schema.companies).set({ referralCode: code }).where(and(eq(schema.companies.id, companyId), sql`${schema.companies.referralCode} is null`)).returning({ code: schema.companies.referralCode }).catch(() => []);
    if (set?.code) return set.code;
  }
  throw new Error("Could not create a referral code");
}

/** Called when a user's first company is created: links it to whoever referred the user. Self-referrals are ignored. */
export async function linkReferral(companyId: string, userId: string, code: string): Promise<void> {
  const clean = code.trim().toUpperCase();
  if (!REFERRAL_CODE.test(clean)) return;
  const db = await getDb();
  const [referrer] = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.referralCode, clean));
  if (!referrer || referrer.id === companyId) return;
  const [selfOwned] = await db.select({ id: schema.companyMembers.id }).from(schema.companyMembers).where(and(eq(schema.companyMembers.companyId, referrer.id), eq(schema.companyMembers.userId, userId)));
  if (selfOwned) return;
  await db.update(schema.companies).set({ referredBy: referrer.id }).where(eq(schema.companies.id, companyId));
}

/**
 * Commission for a paid invoice, as credit to the referrer. Once per invoice,
 * only real money counts (not the part paid with credit), only within the
 * programme's window after the referred company was created.
 */
export async function payReferralCommission(invoiceId: string): Promise<number> {
  const { referralPercent, referralMonths } = await getSettings("billing");
  if (!referralPercent) return 0;
  const db = await getDb();
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv?.companyId || inv.kind !== "invoice" || inv.status !== "paid") return 0;
  const [co] = await db.select().from(schema.companies).where(eq(schema.companies.id, inv.companyId));
  if (!co?.referredBy) return 0;
  const until = new Date(co.createdAt);
  until.setUTCMonth(until.getUTCMonth() + referralMonths);
  if (inv.createdAt > until) return 0;
  const [already] = await db.select({ id: schema.creditLedger.id }).from(schema.creditLedger).where(and(eq(schema.creditLedger.invoiceId, inv.id), eq(schema.creditLedger.companyId, co.referredBy), like(schema.creditLedger.reason, "Referral%")));
  if (already) return 0;
  const [{ cash }] = await db.select({ cash: sql<number>`coalesce(sum(${schema.transactions.amount}) filter (where ${schema.transactions.gateway} <> 'credit'), 0)::int` }).from(schema.transactions).where(eq(schema.transactions.invoiceId, inv.id));
  // Commission on the net amount, in proportion to how much of the invoice was paid with real money.
  const base = inv.total > 0 ? Math.round((inv.subtotal * Math.min(cash, inv.total)) / inv.total) : 0;
  const amount = Math.floor((base * referralPercent) / 100);
  if (amount <= 0) return 0;
  const { adjustCredit } = await import("./billing");
  await adjustCredit(co.referredBy, amount, `Referral: ${co.name}`, null, inv.id);
  return amount;
}

export async function referralStats(companyId: string) {
  const db = await getDb();
  const referred = await db.select({ id: schema.companies.id, createdAt: schema.companies.createdAt }).from(schema.companies).where(eq(schema.companies.referredBy, companyId));
  const [{ earned }] = await db.select({ earned: sql<number>`coalesce(sum(${schema.creditLedger.amount}), 0)::int` }).from(schema.creditLedger).where(and(eq(schema.creditLedger.companyId, companyId), like(schema.creditLedger.reason, "Referral%")));
  return { referred: referred.length, earned };
}
