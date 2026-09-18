import { recordPayment } from "@/lib/billing";
import { getSettings } from "@/lib/settings";
import { verifyStripeSignature } from "@/modules/gateways";

export const dynamic = "force-dynamic";

type CheckoutSession = {
  id: string;
  payment_status: string;
  payment_intent: string | null;
  amount_total: number;
  metadata?: { invoice_id?: string };
};

export async function POST(request: Request) {
  const payload = await request.text();
  const { stripe } = await getSettings("gateways");
  if (!verifyStripeSignature(payload, request.headers.get("stripe-signature") ?? "", stripe.webhookSecret)) {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  const event = JSON.parse(payload) as { type: string; data: { object: CheckoutSession } };
  const session = event.data.object;
  const paid =
    (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") &&
    session.payment_status === "paid";
  const invoiceId = session.metadata?.invoice_id;

  if (paid && invoiceId && /^[0-9a-f-]{36}$/i.test(invoiceId)) {
    // Idempotent on (gateway, externalId): Stripe retries are harmless.
    await recordPayment({ invoiceId, gateway: "stripe", externalId: session.payment_intent ?? session.id, amount: session.amount_total });
  }
  return Response.json({ received: true });
}
