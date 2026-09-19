import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

/** An invoice with everything needed to display, print or email it. */
export async function loadInvoice(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const db = await getDb();
  const invoice = await db.query.invoices.findFirst({
    where: eq(schema.invoices.id, id),
    with: { items: true, transactions: true, client: { columns: { passwordHash: false } } },
  });
  if (!invoice) return undefined;
  const [co] = invoice.companyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, invoice.companyId)) : [];
  if (!co) return { ...invoice, client: { ...invoice.client, taxCode: "" } };
  // Invoices are made out to the company: its billing details win over the owner's profile.
  return {
    ...invoice,
    client: {
      ...invoice.client,
      company: co.orgType === "company" ? co.billingName || co.name : "",
      ...(co.orgType === "individual" && co.billingName ? { firstName: co.billingName, lastName: "" } : {}),
      address: [co.address1, co.address2].filter(Boolean).join(", "),
      city: co.city,
      zip: co.zip,
      state: co.state,
      country: co.country,
      vatId: co.vatId,
      taxCode: co.taxCode,
    },
  };
}

export type LoadedInvoice = NonNullable<Awaited<ReturnType<typeof loadInvoice>>>;
