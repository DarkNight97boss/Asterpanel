import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { guessCountry } from "./countries";
import { buildFatturaPa, fpaFilename, FpaError } from "./fatturapa";
import { invoiceLabel } from "./format";
import type { LoadedInvoice } from "./invoices";
import { getSettings } from "./settings";

/** The FatturaPA file of an invoice, from the saved seller details and the company's billing details. */
export async function invoiceXml(invoice: LoadedInvoice): Promise<{ filename: string; xml: string }> {
  const [seller, billing] = await Promise.all([getSettings("einvoice"), getSettings("billing")]);
  if (!seller.enabled) throw new FpaError("Electronic invoicing is switched off");
  if (invoice.status === "draft" || invoice.status === "cancelled") throw new FpaError("Only issued invoices can be exported");
  const [co] = invoice.companyId ? await (await getDb()).select().from(schema.companies).where(eq(schema.companies.id, invoice.companyId)) : [];
  const c = invoice.client;
  const [credited] = invoice.creditsInvoiceId ? await (await getDb()).select().from(schema.invoices).where(eq(schema.invoices.id, invoice.creditsInvoiceId)) : [];
  const progressive = (invoice.fiscalYear % 100) * 100_000 + invoice.number;
  const xml = buildFatturaPa(
    seller,
    {
      name: c.company || `${c.firstName} ${c.lastName}`.trim(),
      firstName: c.firstName,
      lastName: c.lastName,
      isCompany: !!c.company,
      vatId: c.vatId,
      taxCode: c.taxCode,
      address: c.address,
      zip: c.zip,
      city: c.city,
      province: c.state,
      country: guessCountry(c.country, "it") || "IT",
      sdiCode: co?.sdiCode ?? "",
      pec: co?.pec ?? "",
    },
    {
      number: invoiceLabel(billing.invoicePrefix, invoice),
      progressive,
      date: invoice.createdAt,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      taxRateBp: invoice.taxRate,
      subtotal: invoice.subtotal,
      tax: invoice.tax,
      total: invoice.total,
      paid: invoice.status === "paid",
      credits: credited && { number: invoiceLabel(billing.invoicePrefix, credited), date: credited.createdAt },
      paidBy: invoice.transactions.some((t) => t.gateway === "stripe") ? "card" : "transfer",
      lines: invoice.items.map((i) => ({ description: i.description, amount: i.amount })),
    },
  );
  return { filename: fpaFilename(seller, progressive), xml };
}
