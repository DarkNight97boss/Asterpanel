import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { BillingError, createCustomInvoice } from "./billing";
import { parseMoney } from "./format";

/** `Description | 120.00`, one per line. Throws a message for whoever is typing. */
export function parseQuoteLines(text: string): { description: string; amount: number }[] {
  const items: { description: string; amount: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cut = line.lastIndexOf("|");
    const amount = cut > 0 ? parseMoney(line.slice(cut + 1).trim()) : null;
    if (amount === null || amount <= 0 || !line.slice(0, cut).trim()) throw new BillingError(`Write each line as “Description | 120.00”: ${line.slice(0, 60)}`);
    items.push({ description: line.slice(0, cut).trim().slice(0, 500), amount });
  }
  if (!items.length || items.length > 50) throw new BillingError("A quote needs between 1 and 50 lines");
  return items;
}

export async function createQuote(input: { companyId: string; title: string; lines: string; notes: string; validDays: number; actorId: string | null }): Promise<string> {
  const db = await getDb();
  const [owner] = await db.select({ userId: schema.companyMembers.userId }).from(schema.companyMembers).where(and(eq(schema.companyMembers.companyId, input.companyId), eq(schema.companyMembers.role, "owner")));
  if (!owner?.userId) throw new BillingError("Company not found");
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new BillingError("Give the quote a title");
  const [q] = await db.insert(schema.quotes).values({ companyId: input.companyId, clientId: owner.userId, title, items: parseQuoteLines(input.lines), notes: input.notes.trim().slice(0, 2000), validUntil: new Date(Date.now() + Math.min(365, Math.max(1, Math.round(input.validDays) || 30)) * 86_400_000), createdBy: input.actorId }).returning({ id: schema.quotes.id });
  await audit(input.actorId, "quote.created", "quote", q.id, { title });
  return q.id;
}

/** The customer says yes: the quote becomes an invoice, once. */
export async function acceptQuote(quoteId: string, companyId: string, actorId: string | null): Promise<string> {
  const db = await getDb();
  // Claimed first, so a double click cannot produce two invoices.
  const [q] = await db.update(schema.quotes).set({ status: "accepted", decidedAt: new Date() }).where(and(eq(schema.quotes.id, quoteId), eq(schema.quotes.companyId, companyId), eq(schema.quotes.status, "sent"))).returning();
  if (!q) throw new BillingError("This quote is no longer open");
  if (q.validUntil < new Date()) {
    await db.update(schema.quotes).set({ status: "sent", decidedAt: null }).where(eq(schema.quotes.id, q.id));
    throw new BillingError("This quote has expired. Ask us for a new one.");
  }
  try {
    const invoiceId = await createCustomInvoice({ clientId: q.clientId, companyId: q.companyId, items: q.items, notes: `${q.title} — quote #${q.number}`, dueInDays: 7, actorId });
    await db.update(schema.quotes).set({ invoiceId }).where(eq(schema.quotes.id, q.id));
    await audit(actorId, "quote.accepted", "quote", q.id, { invoiceId });
    return invoiceId;
  } catch (err) {
    await db.update(schema.quotes).set({ status: "sent", decidedAt: null }).where(eq(schema.quotes.id, q.id));
    throw err;
  }
}

export async function closeQuote(quoteId: string, status: "declined" | "withdrawn", companyId: string | null, actorId: string | null) {
  const db = await getDb();
  await db.update(schema.quotes).set({ status, decidedAt: new Date() }).where(and(eq(schema.quotes.id, quoteId), eq(schema.quotes.status, "sent"), ...(companyId ? [eq(schema.quotes.companyId, companyId)] : [])));
  await audit(actorId, `quote.${status}`, "quote", quoteId);
}
