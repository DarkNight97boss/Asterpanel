import "server-only";
import { createHmac } from "node:crypto";
import type { schema } from "@/db";
import { safeEqual } from "@/lib/crypto";
import { invoiceDue } from "@/lib/billing";
import { stripeCustomer } from "@/lib/payment-methods";
import { getSettings, type Settings } from "@/lib/settings";
import { paypalAmount, paypalCall, type PayPalOrder } from "./paypal";
import { stripeCall } from "./stripe";

/**
 * Payment gateway contract. `start` either redirects the client to a hosted
 * checkout or returns offline instructions. Hosted gateways confirm payment
 * asynchronously through `/api/webhooks/<id>`, which ends in
 * `billing.recordPayment` — the single place where an invoice becomes paid.
 */

type Invoice = typeof schema.invoices.$inferSelect;

export type StartPayment = { kind: "redirect"; url: string } | { kind: "instructions"; text: string };

export interface PaymentGateway {
  id: string;
  name: string;
  enabled(config: Settings<"gateways">): boolean;
  start(args: { invoice: Invoice; email: string; returnUrl: string; label: string }): Promise<StartPayment>;
}

const bankTransfer: PaymentGateway = {
  id: "bank-transfer",
  name: "Bank transfer",
  enabled: (c) => c.bankTransfer.enabled,
  async start() {
    const { bankTransferInstructions } = await getSettings("billing");
    return { kind: "instructions", text: bankTransferInstructions || "Contact us for payment details." };
  },
};

const stripe: PaymentGateway = {
  id: "stripe",
  // Stripe Checkout offers Google Pay and Apple Pay by itself on devices that have them.
  name: "Card, Google Pay, Apple Pay",
  enabled: (c) => c.stripe.enabled && !!c.stripe.secretKey,
  async start({ invoice, email, returnUrl, label }) {
    const { stripe: cfg } = await getSettings("gateways");
    // With saved cards on, the payment is tied to the company's customer and the card is kept for renewals.
    // Credit or an earlier partial payment may already cover part of the invoice.
    const due = await invoiceDue(invoice.id);
    const customer = cfg.saveCards && invoice.companyId ? await stripeCustomer(invoice.companyId, email) : "";
    const session = await stripeCall<{ url?: string }>(
      "POST",
      "/checkout/sessions",
      {
        mode: "payment",
        success_url: `${returnUrl}?paid=1`,
        cancel_url: returnUrl,
        ...(customer ? { customer, "payment_intent_data[setup_future_usage]": "off_session" } : { customer_email: email }),
        client_reference_id: invoice.id,
        "metadata[invoice_id]": invoice.id,
        "payment_intent_data[metadata][invoice_id]": invoice.id,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": invoice.currency.toLowerCase(),
        "line_items[0][price_data][unit_amount]": String(due),
        "line_items[0][price_data][product_data][name]": label,
      },
      // A double click must not open two checkout sessions for one invoice state.
      `checkout-${invoice.id}-${due}-${Math.floor(Date.now() / 60_000)}`,
    );
    if (!session.url) throw new Error("Stripe checkout failed");
    return { kind: "redirect", url: session.url };
  },
};

const paypal: PaymentGateway = {
  id: "paypal",
  name: "PayPal",
  enabled: (c) => c.paypal.enabled && !!c.paypal.clientId && !!c.paypal.secret,
  async start({ invoice, returnUrl, label }) {
    const origin = new URL(returnUrl).origin;
    const due = await invoiceDue(invoice.id);
    const order = await paypalCall<PayPalOrder>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: invoice.id, custom_id: invoice.id, description: label.slice(0, 127), amount: { currency_code: invoice.currency, value: paypalAmount(due) } }],
        payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", return_url: `${origin}/api/paypal/return`, cancel_url: returnUrl } } },
      },
      `order-${invoice.id}-${due}-${Math.floor(Date.now() / 60_000)}`,
    );
    const approve = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!approve) throw new Error("PayPal checkout failed");
    return { kind: "redirect", url: approve };
  },
};

export const gateways: PaymentGateway[] = [stripe, paypal, bankTransfer];

export async function enabledGateways(): Promise<PaymentGateway[]> {
  const config = await getSettings("gateways");
  return gateways.filter((g) => g.enabled(config));
}

/** Verifies a `Stripe-Signature` header (scheme v1, 5 minute tolerance). */
export function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  const parts = new Map(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = parts.get("t");
  if (!t || !secret || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .some((p) => safeEqual(p.slice(3), expected));
}
