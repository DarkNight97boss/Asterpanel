import "server-only";
import { createHmac } from "node:crypto";
import type { schema } from "@/db";
import { safeEqual } from "@/lib/crypto";
import { getSettings, type Settings } from "@/lib/settings";

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
  name: "Credit / debit card",
  enabled: (c) => c.stripe.enabled && !!c.stripe.secretKey,
  async start({ invoice, email, returnUrl, label }) {
    const { stripe: cfg } = await getSettings("gateways");
    const body = new URLSearchParams({
      mode: "payment",
      success_url: `${returnUrl}?paid=1`,
      cancel_url: returnUrl,
      customer_email: email,
      client_reference_id: invoice.id,
      "metadata[invoice_id]": invoice.id,
      "payment_intent_data[metadata][invoice_id]": invoice.id,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": invoice.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(invoice.total),
      "line_items[0][price_data][product_data][name]": label,
    });
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // A double click must not open two checkout sessions for one invoice state.
        "Idempotency-Key": `checkout-${invoice.id}-${invoice.total}-${Math.floor(Date.now() / 60_000)}`,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as { url?: string; error?: { message?: string } };
    if (!res.ok || !json.url) throw new Error(json.error?.message ?? "Stripe checkout failed");
    return { kind: "redirect", url: json.url };
  },
};

export const gateways: PaymentGateway[] = [stripe, bankTransfer];

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
