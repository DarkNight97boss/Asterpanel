import { getUser, isStaff } from "@/lib/auth";
import { renderInvoicePdf } from "@/lib/invoice-pdf";
import { loadInvoice } from "@/lib/invoices";
import { listAccounts, roleCan } from "@/lib/roles";

export const dynamic = "force-dynamic";

/** Invoice PDF for the members of its company who may see billing, or for staff. `?download=1` forces a download. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const invoice = await loadInvoice((await params).id);
  // Same answer for "missing" and "not yours": ids must not be probeable.
  const mine = invoice && (invoice.clientId === user.id || (await listAccounts(user)).some((a) => a.id === invoice.companyId && roleCan(a.role, "billing")));
  if (!invoice || (!mine && !isStaff(user))) return new Response("Not found", { status: 404 });

  const { filename, bytes } = await renderInvoicePdf(invoice);
  const disposition = new URL(request.url).searchParams.has("download") ? "attachment" : "inline";
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
