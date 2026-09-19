import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { recordPayment } from "@/lib/billing";
import { verifyPayPalWebhook } from "@/modules/gateways/paypal";

export const dynamic = "force-dynamic";

type Capture = { id: string; status: string; custom_id?: string; amount: { currency_code: string; value: string } };

/** Safety net for customers who pay and close the tab before coming back. */
export async function POST(request: Request) {
  const payload = await request.text();
  let event: { event_type?: string; resource?: Capture };
  try {
    event = JSON.parse(payload);
  } catch {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }
  if (!(await verifyPayPalWebhook(request.headers, event))) return Response.json({ error: "Invalid signature" }, { status: 400 });

  const c = event.resource;
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && c?.status === "COMPLETED" && /^[0-9a-f-]{36}$/i.test(c.custom_id ?? "")) {
    const [invoice] = await (await getDb()).select().from(schema.invoices).where(eq(schema.invoices.id, c.custom_id!));
    // Idempotent on (gateway, capture id): the return URL may already have recorded it.
    if (invoice && invoice.currency === c.amount.currency_code) await recordPayment({ invoiceId: invoice.id, gateway: "paypal", externalId: c.id, amount: Math.round(Number(c.amount.value) * 100) });
  }
  return Response.json({ received: true });
}
