import "server-only";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { decryptJson, encryptJson, randomToken } from "./crypto";
import { publicHttpsUrl } from "./net";

/**
 * Outgoing webhooks. Each delivery is a JSON POST signed like Stripe's:
 * `X-Aster-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<body>">`.
 * Deliveries never block or fail the operation that caused them.
 */

export const WEBHOOK_EVENTS = ["deploy.succeeded", "deploy.failed", "backup.completed", "backup.failed", "migration.succeeded", "migration.failed", "invoice.created", "invoice.paid", "domain.registered", "service.cancel_requested"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_FAILURES = 20;

export class WebhookError extends Error {}

let http: typeof fetch = (...args) => fetch(...args);
export const setWebhookHttpForTests = (fake: typeof fetch) => void (http = fake);
const pending = new Set<Promise<unknown>>();
/** Tests (and graceful shutdowns) wait for deliveries in flight. */
export const flushWebhooks = () => Promise.allSettled([...pending]);

export const sign = (secret: string, timestamp: number, body: string) => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

export type WebhookFormat = "json" | "slack" | "discord" | "telegram";
const CHAT_HOSTS: Record<Exclude<WebhookFormat, "json">, RegExp> = { slack: /^hooks\.slack\.com$/, discord: /^(discord|discordapp)\.com$/, telegram: /^api\.telegram\.org$/ };

/** Chat webhook addresses are credentials (they carry a token): stored encrypted, shown by host only. */
export const webhookAddress = (hook: { url: string; format: string }) => (hook.format === "json" ? hook.url : decryptJson<string>(hook.url, ""));
export const webhookLabel = (hook: { url: string; format: string }) => (hook.format === "json" ? hook.url : `${hook.format} · ${new URL(webhookAddress(hook) || "https://unknown.invalid").hostname}`);

/** One readable line per event, for chat channels. */
export function chatMessage(event: string, data: Record<string, unknown>): string {
  const site = (data.site as { name?: string } | undefined)?.name;
  const money = typeof data.total === "number" ? ` (${(data.total / 100).toFixed(2)} ${String(data.currency ?? "")})`.trimEnd() : "";
  const text: Record<string, string> = {
    "deploy.succeeded": `✅ Deploy live: ${site}`,
    "deploy.failed": `❌ Deploy failed: ${site} — ${String(data.error ?? "").slice(0, 200)}`,
    "backup.completed": `💾 Backup ready: ${site}`,
    "backup.failed": `⚠️ Backup failed: ${site} — ${String(data.error ?? "").slice(0, 200)}`,
    "migration.succeeded": `✅ Migration finished: ${site}`,
    "migration.failed": `❌ Migration failed: ${site} — ${String(data.error ?? "").slice(0, 200)}`,
    "invoice.created": `🧾 New invoice${money}`,
    "invoice.paid": `💶 Invoice paid${money}`,
    "domain.registered": `🌐 Domain registered: ${String(data.domain ?? "")}`,
    "service.cancel_requested": `👋 Cancellation requested for service ${String(data.serviceId ?? "")}`,
    ping: "👋 It works.",
  };
  return text[event] ?? event;
}

export async function createWebhook(companyId: string, input: { url: string; events: string[]; format?: WebhookFormat; chatId?: string }): Promise<{ id: string; secret: string }> {
  const url = publicHttpsUrl(input.url);
  if (!url) throw new WebhookError("Enter a public https:// address");
  const format = input.format ?? "json";
  // A chat format only ever talks to that chat service: the address cannot be pointed elsewhere.
  if (format !== "json" && !CHAT_HOSTS[format].test(url.hostname)) throw new WebhookError("This address does not belong to the chosen chat service");
  const chatId = (input.chatId ?? "").trim();
  if (format === "telegram" && (!/^-?\d{1,20}$|^@[\w]{3,64}$/.test(chatId) || !/^\/bot[\w:-]+\/sendMessage$/.test(url.pathname))) throw new WebhookError("Telegram needs https://api.telegram.org/bot<token>/sendMessage and a chat id");
  const events = input.events.filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (!events.length) throw new WebhookError("Choose at least one event");
  const db = await getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.webhooks).where(eq(schema.webhooks.companyId, companyId));
  if (n >= 10) throw new WebhookError("A company can have up to 10 webhooks");
  const secret = `whsec_${randomToken(24)}`;
  const [row] = await db.insert(schema.webhooks).values({ companyId, url: format === "json" ? url.href : encryptJson(url.href), format, chatId, events, secret: encryptJson(secret) }).returning({ id: schema.webhooks.id });
  return { id: row.id, secret };
}

export const deleteWebhook = async (companyId: string, id: string) => (await getDb()).delete(schema.webhooks).where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.companyId, companyId)));

async function deliver(hook: typeof schema.webhooks.$inferSelect, event: string, data: Record<string, unknown>) {
  const db = await getDb();
  const chat = hook.format !== "json";
  const message = chat ? chatMessage(event, data) : "";
  const body = hook.format === "slack" ? JSON.stringify({ text: message }) : hook.format === "discord" ? JSON.stringify({ content: message }) : hook.format === "telegram" ? JSON.stringify({ chat_id: hook.chatId, text: message, disable_web_page_preview: true }) : JSON.stringify({ id: randomToken(12), type: event, created: new Date().toISOString(), data });
  const t = Math.floor(Date.now() / 1000);
  let status: string;
  try {
    // Redirects are not followed: the address the customer saved is the only one contacted.
    const res = await http(webhookAddress(hook), { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "Content-Type": "application/json", "User-Agent": "AsterPanel-Webhooks/1", ...(chat ? {} : { "X-Aster-Event": event, "X-Aster-Signature": `t=${t},v1=${sign(decryptJson<string>(hook.secret, ""), t, body)}` }) } });
    status = String(res.status);
  } catch (err) {
    status = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "unreachable";
  }
  const ok = /^2\d\d$/.test(status);
  const failures = ok ? 0 : hook.failures + 1;
  // An endpoint that keeps failing is switched off instead of being hammered forever.
  await db.update(schema.webhooks).set({ lastStatus: status, lastAt: new Date(), failures, enabled: failures < MAX_FAILURES }).where(eq(schema.webhooks.id, hook.id));
}

/** Fire-and-forget: notifies the company's endpoints subscribed to `event`. */
export function emitEvent(companyId: string | null | undefined, event: WebhookEvent, data: Record<string, unknown>): void {
  if (!companyId) return;
  const work = (async () => {
    const db = await getDb();
    const hooks = await db.select().from(schema.webhooks).where(and(eq(schema.webhooks.companyId, companyId), eq(schema.webhooks.enabled, true)));
    await Promise.all(hooks.filter((h) => h.events.includes(event)).map((h) => deliver(h, event, data)));
  })().catch(() => {});
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/** Sends a sample event right now and reports what the endpoint answered. */
export async function testWebhook(companyId: string, id: string): Promise<string> {
  const db = await getDb();
  const [hook] = await db.select().from(schema.webhooks).where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.companyId, companyId)));
  if (!hook) throw new WebhookError("Webhook not found");
  await deliver(hook, "ping", { message: "It works." });
  const [after] = await db.select({ s: schema.webhooks.lastStatus }).from(schema.webhooks).where(eq(schema.webhooks.id, id));
  return after.s;
}
