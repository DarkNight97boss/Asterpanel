import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let keys: typeof import("../src/lib/api-keys");
let hooks: typeof import("../src/lib/webhooks");
let companyId: string, otherCompany: string;
const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
let answer = 200;

before(async () => {
  dbm = await import("../src/db");
  keys = await import("../src/lib/api-keys");
  hooks = await import("../src/lib/webhooks");
  hooks.setWebhookHttpForTests((async (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response("", { status: answer });
  }) as unknown as typeof fetch);
  const db = await dbm.getDb();
  [{ id: companyId }] = await db.insert(dbm.schema.companies).values({ name: "Acme" }).returning();
  [{ id: otherCompany }] = await db.insert(dbm.schema.companies).values({ name: "Other" }).returning();
});

test("API keys: shown once, stored hashed, scoped, expirable and revocable", async () => {
  const db = await dbm.getDb();
  const { id, token } = await keys.createApiKey({ companyId, name: "CI", scope: "read", createdBy: null });
  assert.match(token, /^ak_live_[\w-]{40,}$/);
  const [row] = await db.select().from(dbm.schema.apiKeys).where(eq(dbm.schema.apiKeys.id, id));
  assert.ok(!JSON.stringify(row).includes(token.slice(14)), "the secret part is not stored");
  assert.ok(token.startsWith(row.prefix));

  assert.deepEqual(await keys.verifyApiKey(`Bearer ${token}`), { keyId: id, companyId, scope: "read", createdBy: null });
  for (const bad of [null, "", token, `Basic ${token}`, `Bearer ${token}x`, "Bearer ak_live_nope", `Bearer ${"a".repeat(500)}`]) assert.equal(await keys.verifyApiKey(bad), null, String(bad).slice(0, 20));
  assert.ok((await db.select().from(dbm.schema.apiKeys).where(eq(dbm.schema.apiKeys.id, id)))[0].lastUsedAt);

  const expired = await keys.createApiKey({ companyId, name: "Old", scope: "write", createdBy: null, expiresInDays: 1 });
  await db.update(dbm.schema.apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(dbm.schema.apiKeys.id, expired.id));
  assert.equal(await keys.verifyApiKey(`Bearer ${expired.token}`), null);

  await keys.revokeApiKey(otherCompany, id);
  assert.ok(await keys.verifyApiKey(`Bearer ${token}`), "another company cannot revoke it");
  await keys.revokeApiKey(companyId, id);
  assert.equal(await keys.verifyApiKey(`Bearer ${token}`), null);
});

test("webhooks: public https only, signed deliveries to subscribers, switched off after repeated failures", async () => {
  const db = await dbm.getDb();
  for (const url of ["http://example.com/h", "https://localhost/h", "https://10.0.0.8/h", "https://169.254.169.254/", "https://user:pw@example.com/", "https://intranet/h", "ftp://example.com"]) await assert.rejects(hooks.createWebhook(companyId, { url, events: ["deploy.succeeded"] }), /public https/, url);
  await assert.rejects(hooks.createWebhook(companyId, { url: "https://example.com/h", events: ["made.up"] }), /at least one event/);

  const { id, secret } = await hooks.createWebhook(companyId, { url: "https://example.com/hooks", events: ["deploy.succeeded", "bogus"] });
  assert.match(secret, /^whsec_/);
  assert.ok(!(await db.select().from(dbm.schema.webhooks).where(eq(dbm.schema.webhooks.id, id)))[0].secret.includes(secret), "secret encrypted at rest");

  hooks.emitEvent(companyId, "deploy.succeeded", { site: { id: "s1" } });
  hooks.emitEvent(companyId, "invoice.paid", { invoiceId: "i1" }); // not subscribed
  hooks.emitEvent(otherCompany, "deploy.succeeded", {}); // another company
  hooks.emitEvent(null, "deploy.succeeded", {});
  await hooks.flushWebhooks();
  assert.equal(sent.length, 1);
  const { body, headers } = sent[0];
  assert.deepEqual([JSON.parse(body).type, JSON.parse(body).data.site.id, headers["X-Aster-Event"]], ["deploy.succeeded", "s1", "deploy.succeeded"]);
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers["X-Aster-Signature"])!;
  assert.equal(v1, hooks.sign(secret, Number(t), body), "the receiver can verify the body with its secret");

  answer = 500;
  assert.equal(await hooks.testWebhook(companyId, id), "500");
  await db.update(dbm.schema.webhooks).set({ failures: 19 }).where(eq(dbm.schema.webhooks.id, id));
  hooks.emitEvent(companyId, "deploy.succeeded", {});
  await hooks.flushWebhooks();
  const [off] = await db.select().from(dbm.schema.webhooks).where(eq(dbm.schema.webhooks.id, id));
  assert.deepEqual([off.enabled, off.failures], [false, 20]);
  const before = sent.length;
  hooks.emitEvent(companyId, "deploy.succeeded", {});
  await hooks.flushWebhooks();
  assert.equal(sent.length, before, "a disabled endpoint is left alone");
  await assert.rejects(hooks.testWebhook(otherCompany, id), /not found/);
});

test("chat webhooks: only the real chat hosts, address encrypted, a readable message in each service's shape", async () => {
  const db = await dbm.getDb();
  answer = 200;
  await assert.rejects(hooks.createWebhook(companyId, { url: "https://evil.example.com/services/T/B/x", events: ["deploy.failed"], format: "slack" }), /does not belong/);
  await assert.rejects(hooks.createWebhook(companyId, { url: "https://api.telegram.org/botTOKEN/sendMessage", events: ["deploy.failed"], format: "telegram", chatId: "not a chat" }), /Telegram needs/);
  await assert.rejects(hooks.createWebhook(companyId, { url: "https://api.telegram.org/botTOKEN/deleteWebhook", events: ["deploy.failed"], format: "telegram", chatId: "-100123" }), /Telegram needs/);

  const slack = await hooks.createWebhook(companyId, { url: "https://hooks.slack.com/services/T000/B000/secretpart", events: ["deploy.failed"], format: "slack" });
  await hooks.createWebhook(companyId, { url: "https://discord.com/api/webhooks/1/tok", events: ["deploy.failed"], format: "discord" });
  await hooks.createWebhook(companyId, { url: "https://api.telegram.org/bot123:ABC/sendMessage", events: ["deploy.failed"], format: "telegram", chatId: "-100123" });
  const [row] = await db.select().from(dbm.schema.webhooks).where(eq(dbm.schema.webhooks.id, slack.id));
  assert.ok(!row.url.includes("secretpart"), "the address is a credential: encrypted at rest");
  assert.equal(hooks.webhookLabel(row), "slack · hooks.slack.com");

  sent.length = 0;
  hooks.emitEvent(companyId, "deploy.failed", { site: { name: "Shop" }, error: "npm ERR! missing script" });
  await hooks.flushWebhooks();
  const byHost = Object.fromEntries(sent.map((s) => [new URL(s.url).hostname, JSON.parse(s.body)]));
  assert.deepEqual(byHost["hooks.slack.com"], { text: "❌ Deploy failed: Shop — npm ERR! missing script" });
  assert.equal(byHost["discord.com"].content, "❌ Deploy failed: Shop — npm ERR! missing script");
  assert.deepEqual([byHost["api.telegram.org"].chat_id, byHost["api.telegram.org"].text.startsWith("❌")], ["-100123", true]);
  assert.ok(sent.every((s) => !("X-Aster-Signature" in s.headers)), "chat services get no signature header");
  assert.equal(hooks.chatMessage("invoice.paid", { total: 1220, currency: "EUR" }), "💶 Invoice paid (12.20 EUR)");
});
