import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { recordPayment } from "@/lib/billing";
import { baseUrl } from "@/lib/url";
import { capturePayPalOrder } from "@/modules/gateways/paypal";

export const dynamic = "force-dynamic";

/** Where PayPal sends the customer back after approving. Only PayPal's capture answer decides what was paid. */
export async function GET(request: Request) {
  const orderId = new URL(request.url).searchParams.get("token") ?? "";
  const origin = await baseUrl();
  const captured = await capturePayPalOrder(orderId).catch(() => null);
  if (!captured) return Response.redirect(`${origin}/client/invoices?payment=failed`, 303);
  const [invoice] = await (await getDb()).select().from(schema.invoices).where(eq(schema.invoices.id, captured.invoiceId));
  // A capture in another currency is recorded by staff, not guessed at.
  if (invoice && invoice.currency === captured.currency) await recordPayment({ invoiceId: invoice.id, gateway: "paypal", externalId: captured.captureId, amount: captured.cents });
  return Response.redirect(`${origin}/client/invoices/${captured.invoiceId}?paid=1`, 303);
}
