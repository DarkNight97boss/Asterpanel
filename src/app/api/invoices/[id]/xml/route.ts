import { getUser } from "@/lib/auth";
import { invoiceXml } from "@/lib/einvoice";
import { FpaError } from "@/lib/fatturapa";
import { loadInvoice } from "@/lib/invoices";
import { staffCan } from "@/lib/staff";

export const dynamic = "force-dynamic";

/** FatturaPA XML of an invoice, for billing staff to hand to their SDI intermediary. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const invoice = await loadInvoice((await params).id);
  if (!invoice || !staffCan(user, "billing")) return new Response("Not found", { status: 404 });
  try {
    const { filename, xml } = await invoiceXml(invoice);
    return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof FpaError) return new Response(err.message, { status: 422, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    throw err;
  }
}
