import "server-only";
import { getSettings } from "@/lib/settings";
import { gatewayHttp } from "./http";

/** Minimal Stripe REST client: form-encoded requests, JSON answers, idempotency keys on writes. */

export class StripeError extends Error {
  constructor(message: string, readonly code = "") {
    super(message);
  }
}

export async function stripeCall<T>(method: "GET" | "POST", path: string, params: Record<string, string> = {}, idempotencyKey?: string): Promise<T> {
  const { stripe } = await getSettings("gateways");
  if (!stripe.secretKey) throw new StripeError("Stripe is not configured");
  const query = new URLSearchParams(params);
  const res = await gatewayHttp(`https://api.stripe.com/v1${path}${method === "GET" && query.size ? `?${query}` : ""}`, {
    method,
    headers: { Authorization: `Bearer ${stripe.secretKey}`, "Content-Type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: method === "POST" ? query : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: string; decline_code?: string } };
  if (!res.ok) throw new StripeError(json.error?.message ?? `Stripe answered ${res.status}`, json.error?.decline_code ?? json.error?.code ?? "");
  return json;
}

export type StripeCard = { id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } };
export type StripeIntent = { id: string; status: string; amount_received: number; amount: number; currency: string; customer: string | null; metadata?: { invoice_id?: string }; payment_method: string | StripeCard | null; last_payment_error?: { message?: string } };
