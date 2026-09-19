import "server-only";
import { getSettings } from "@/lib/settings";
import { gatewayHttp } from "./http";

/** PayPal Orders v2: create → customer approves on paypal.com → capture. */

export class PayPalError extends Error {}

const api = (sandbox: boolean) => (sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com");

async function token(): Promise<{ base: string; bearer: string }> {
  const { paypal } = await getSettings("gateways");
  if (!paypal.clientId || !paypal.secret) throw new PayPalError("PayPal is not configured");
  const base = api(paypal.sandbox);
  const res = await gatewayHttp(`${base}/v1/oauth2/token`, { method: "POST", body: "grant_type=client_credentials", headers: { Authorization: `Basic ${Buffer.from(`${paypal.clientId}:${paypal.secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new PayPalError(json.error_description ?? "PayPal refused the credentials");
  return { base, bearer: json.access_token };
}

export async function paypalCall<T>(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<T> {
  const { base, bearer } = await token();
  const res = await gatewayHttp(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) }, signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string; details?: { description?: string }[] };
  if (!res.ok) throw new PayPalError(json.details?.[0]?.description ?? json.message ?? `PayPal answered ${res.status}`);
  return json;
}

/** Cents → "12.20". Currencies without decimals are not supported by this module. */
export const paypalAmount = (cents: number) => (cents / 100).toFixed(2);

export type PayPalOrder = { id: string; status: string; links?: { rel: string; href: string }[]; purchase_units?: { custom_id?: string; payments?: { captures?: { id: string; status: string; custom_id?: string; amount: { currency_code: string; value: string } }[] } }[] };

/**
 * Captures an approved order and returns what was really paid. The caller
 * trusts only this answer from PayPal, never the query string of the return URL.
 */
export async function capturePayPalOrder(orderId: string): Promise<{ captureId: string; invoiceId: string; cents: number; currency: string } | null> {
  if (!/^[A-Z0-9]{10,30}$/.test(orderId)) return null;
  let order: PayPalOrder;
  try {
    order = await paypalCall<PayPalOrder>("POST", `/v2/checkout/orders/${orderId}/capture`, {}, `capture-${orderId}`);
  } catch (err) {
    // Already captured (a reload, or the webhook was faster): read it back instead.
    if (!(err instanceof PayPalError) || !/already.*captured/i.test(err.message)) throw err;
    order = await paypalCall<PayPalOrder>("GET", `/v2/checkout/orders/${orderId}`);
  }
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.find((c) => c.status === "COMPLETED");
  const invoiceId = capture?.custom_id ?? unit?.custom_id ?? "";
  if (order.status !== "COMPLETED" || !capture || !/^[0-9a-f-]{36}$/i.test(invoiceId)) return null;
  return { captureId: capture.id, invoiceId, cents: Math.round(Number(capture.amount.value) * 100), currency: capture.amount.currency_code };
}

/** Asks PayPal itself whether a webhook call is genuine. */
export async function verifyPayPalWebhook(headers: Headers, event: unknown): Promise<boolean> {
  const { paypal } = await getSettings("gateways");
  if (!paypal.webhookId) return false;
  const h = (n: string) => headers.get(n) ?? "";
  const r = await paypalCall<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", { auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"), transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"), webhook_id: paypal.webhookId, webhook_event: event }).catch(() => ({ verification_status: "" }));
  return r.verification_status === "SUCCESS";
}
