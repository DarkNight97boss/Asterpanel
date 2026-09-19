import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { apiAuth, json } from "@/lib/api";
import { invoiceLabel } from "@/lib/format";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caller = await apiAuth(request);
  if (caller instanceof Response) return caller;
  const prefix = (await getSettings("billing")).invoicePrefix;
  const rows = await (await getDb()).select().from(schema.invoices).where(eq(schema.invoices.companyId, caller.companyId)).orderBy(desc(schema.invoices.createdAt)).limit(200);
  return json({ data: rows.map((i) => ({ id: i.id, number: invoiceLabel(prefix, i), kind: i.kind, status: i.status, currency: i.currency, subtotal: i.subtotal, tax: i.tax, total: i.total, dueDate: i.dueDate, paidAt: i.paidAt, createdAt: i.createdAt })) });
}
