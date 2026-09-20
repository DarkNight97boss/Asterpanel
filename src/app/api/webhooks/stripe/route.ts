import { recordPayment } from "@/lib/billing";
import { debitFailed, rememberStripeCard } from "@/lib/payment-methods";
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
    // Keeping the card is a convenience: it must never make the webhook fail.
    if (session.payment_intent) await rememberStripeCard(session.payment_intent).catch(() => {});
  }
  // Automatic charges that finish later (3-D Secure done by the customer, slow networks).
  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object as unknown as { id: string; amount_received: number; metadata?: { invoice_id?: string } };
    const id = intent.metadata?.invoice_id;
    if (id && /^[0-9a-f-]{36}$/i.test(id)) await recordPayment({ invoiceId: id, gateway: "stripe", externalId: intent.id, amount: intent.amount_received });
  }
  // A SEPA debit refused by the bank, days after it was started.
  if (event.type === "payment_intent.payment_failed") {
    const intent = event.data.object as unknown as { id: string; last_payment_error?: { message?: string } };
    if (/^pi_\w+$/.test(intent.id)) await debitFailed(intent.id, intent.last_payment_error?.message ?? "");
  }
  return Response.json({ received: true });
}
