import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

/** An invoice with everything needed to display, print or email it. */
export async function loadInvoice(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const db = await getDb();
  return db.query.invoices.findFirst({
    where: eq(schema.invoices.id, id),
    with: { items: true, transactions: true, client: { columns: { passwordHash: false } } },
  });
}

export type LoadedInvoice = NonNullable<Awaited<ReturnType<typeof loadInvoice>>>;
