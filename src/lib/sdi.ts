import "server-only";
import { and, asc, eq, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSdiProvider, SdiError, type Http } from "@/modules/sdi";
import { audit } from "./audit";
import { invoiceXml } from "./einvoice";
import { FpaError } from "./fatturapa";
import { loadInvoice } from "./invoices";
import { getSettings } from "./settings";

/** Sending electronic invoices to the SDI through the intermediary the administrator chose. */

let http: Http = (...args) => fetch(...args);
export const setSdiHttpForTests = (fake: Http) => void (http = fake);

export class SdiSendError extends Error {}

async function active() {
  const s = await getSettings("sdi");
  const provider = getSdiProvider(s.provider);
  const creds = s.accounts[s.provider];
  if (!provider || !creds || !Object.values(creds).some(Boolean)) throw new SdiSendError("No SDI intermediary is configured");
  return { provider, creds, autoSend: s.autoSend };
}

/** Hands one invoice to the intermediary. Refuses to send the same document twice unless the SDI rejected it. */
export async function sendToSdi(invoiceId: string, actorId: string | null = null): Promise<void> {
  const db = await getDb();
  const invoice = await loadInvoice(invoiceId);
  if (!invoice) throw new SdiSendError("Invoice not found");
  if (invoice.sdiStatus && invoice.sdiStatus !== "rejected" && invoice.sdiStatus !== "error") throw new SdiSendError("This invoice was already sent to the SDI");
  const { provider, creds } = await active();
  try {
    const doc = await invoiceXml(invoice);
    // Marked before the call: if the answer is lost, staff sees "sent" and checks, instead of sending a duplicate.
    await db.update(schema.invoices).set({ sdiProvider: provider.id, sdiStatus: "sent", sdiMessage: "", sdiSentAt: new Date() }).where(eq(schema.invoices.id, invoice.id));
    const { externalId } = await provider.send(creds, doc, http);
    await db.update(schema.invoices).set({ sdiId: externalId }).where(eq(schema.invoices.id, invoice.id));
    await audit(actorId, "invoice.sdi_sent", "invoice", invoice.id, { provider: provider.id });
  } catch (err) {
    const message = err instanceof SdiError || err instanceof FpaError ? err.message : "The intermediary could not be reached";
    await db.update(schema.invoices).set({ sdiStatus: "error", sdiMessage: message.slice(0, 300) }).where(eq(schema.invoices.id, invoice.id));
    await audit(actorId, "invoice.sdi_failed", "invoice", invoice.id, { provider: provider.id, error: message.slice(0, 200) });
    throw new SdiSendError(message);
  }
}

export async function refreshSdiStatus(invoiceId: string): Promise<void> {
  const db = await getDb();
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv?.sdiId || !inv.sdiProvider) return;
  const s = await getSettings("sdi");
  const provider = getSdiProvider(inv.sdiProvider);
  const creds = s.accounts[inv.sdiProvider];
  if (!provider || !creds) return;
  const { status, message } = await provider.status(creds, inv.sdiId, http);
  await db.update(schema.invoices).set({ sdiStatus: status, sdiMessage: message.slice(0, 300) }).where(eq(schema.invoices.id, inv.id));
}

/** Cron: asks for the outcome of what is still pending, oldest first. */
export async function pollSdi(limit = 40): Promise<number> {
  const db = await getDb();
  const pending = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(and(eq(schema.invoices.sdiStatus, "sent"), lt(schema.invoices.sdiSentAt, new Date(Date.now() - 5 * 60_000)))).orderBy(asc(schema.invoices.sdiSentAt)).limit(limit);
  let done = 0;
  for (const { id } of pending) await refreshSdiStatus(id).then(() => done++, () => {});
  return done;
}

/** Called when an invoice becomes paid. Never throws: e-invoicing must not get in the way of a payment. */
export async function autoSendToSdi(invoiceId: string): Promise<void> {
  try {
    if (!(await getSettings("einvoice")).enabled) return;
    if ((await active()).autoSend !== "paid") return;
    await sendToSdi(invoiceId);
  } catch {
    // Recorded on the invoice by sendToSdi; staff retries from its page.
  }
}
