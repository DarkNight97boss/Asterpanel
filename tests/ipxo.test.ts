import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let ipxo: typeof import("../src/lib/ipxo");
let pools: typeof import("../src/lib/ip-pools");
let settings: typeof import("../src/lib/settings");

const calls: { method: string; url: string; body: string; auth: string }[] = [];
let subscriptions: unknown = { data: [] };
let paymentMethods: unknown[] = [{ uuid: "pm-old" }, { uuid: "pm-main", is_default: true }];
let tokenRequests = 0;
let cartItems: unknown[] = [{}];

const fake = (async (url: string, init: RequestInit = {}) => {
  const headers = (init.headers ?? {}) as Record<string, string>;
  calls.push({ method: init.method ?? "GET", url, body: String(init.body ?? ""), auth: headers.Authorization ?? "" });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (url === "https://hydra.ipxo.com/oauth2/token") {
    tokenRequests++;
    return new URLSearchParams(String(init.body)).get("client_secret") === "right" ? json({ access_token: "tok-1", expires_in: 3600 }) : json({ error: "invalid_client", error_description: "Client authentication failed" }, 401);
  }
  if (url.includes("/market/search")) return json({ data: [{ address: "203.0.113.0", prefix_length: 24, price: 120.5, geo_country_code: "IT" }, { address: "10.0.0.0", prefix_length: 24, price: 1 }] });
  if (url.endsWith("/cart/items")) return new Response(null, { status: 204 });
  if (url.endsWith("/tenant-1/cart")) return json({ data: { uuid: "cart-9", items: cartItems } });
  if (url.includes("/addresses?")) return json({ data: [{ uuid: "addr-1" }] });
  if (url.includes("/payment-methods?")) return json({ data: paymentMethods });
  if (url.endsWith("/subscriptions/search")) return json(subscriptions);
  if (url.includes("/asn/validate/")) return url.endsWith("/64500") ? json({ valid: true }) : json({ message: "ASN is not valid" }, 422);
  return json({});
}) as typeof fetch;

before(async () => {
  dbm = await import("../src/db");
  ipxo = await import("../src/lib/ipxo");
  pools = await import("../src/lib/ip-pools");
  settings = await import("../src/lib/settings");
  ipxo.setIpxoHttpForTests(fake);
});

const configure = (patch: Record<string, unknown> = {}) => settings.updateSettings("ipxo", { enabled: true, clientId: "app", clientSecret: "right", tenantUuid: "tenant-1", scopes: "billing", asn: "64500", companyName: "Aster Srl", ...patch });

test("nothing is called without an account, and the secret is encrypted at rest", async () => {
  await assert.rejects(ipxo.testIpxo(), /app key/);
  assert.equal(calls.length, 0);
  await configure();
  const db = await dbm.getDb();
  const [row] = await db.select().from(dbm.schema.settings).where(eq(dbm.schema.settings.key, "ipxo"));
  assert.equal(typeof row.value, "string");
  assert.ok(!String(row.value).includes("right"));
});

test("a wrong secret is reported with IPXO's words", async () => {
  await configure({ clientSecret: "wrong" });
  await assert.rejects(ipxo.testIpxo(), /Client authentication failed/);
  await configure();
});

test("market search: client credentials, bearer token re-used, private ranges dropped", async () => {
  ipxo.setIpxoHttpForTests(fake);
  tokenRequests = 0;
  calls.length = 0;
  const found = await ipxo.searchMarket({ prefixLength: 24, country: "it" });
  assert.deepEqual(found, [{ cidr: "203.0.113.0/24", monthly: 120.5, currency: "USD", country: "IT" }]);
  const token = new URLSearchParams(calls[0].body);
  assert.equal(token.get("grant_type"), "client_credentials");
  assert.equal(token.get("scope"), "billing");
  assert.match(calls[1].url, /^https:\/\/apigw\.ipxo\.com\/billing\/v1\/tenant-1\/market\/search\?prefix_length=24&limit=20&sort=price&geo_country_code=IT$/);
  assert.equal(calls[1].auth, "Bearer tok-1");
  await ipxo.searchMarket({ prefixLength: 24 });
  assert.equal(tokenRequests, 1);
  await assert.rejects(ipxo.searchMarket({ prefixLength: 28 }), /\/16 to \/24/);
  await assert.rejects(ipxo.searchMarket({ prefixLength: 24, country: "Italy" }), /two-letter/);
});

test("ordering: cart, billing address, the default payment method, checkout; then the block shows up", async () => {
  calls.length = 0;
  subscriptions = { data: [{ uuid: "sub-1", status: "active", next_billing_at: "2026-10-20T00:00:00Z", items: [{ product_type: "ipv4", product_fields: { address: "203.0.113.0", cidr: 24 } }] }] };
  await ipxo.orderBlock("203.0.113.0/24");
  const steps = calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.split("/tenant-1")[1]}`);
  assert.deepEqual(steps, ["POST /cart/items", "POST /cart/cart-9/addresses/addr-1", "PATCH /cart/cart-9/payment-method/pm-main", "POST /cart/cart-9/checkout", "POST /subscriptions/search"]);
  assert.deepEqual(JSON.parse(calls.find((c) => c.url.endsWith("/cart/items"))!.body), { product_type: "ipv4", billing_cycle: 1, product_fields: { address: "203.0.113.0", cidr: 24 } });
  const [row] = await ipxo.listIpBlocks();
  assert.equal(row.block.cidr, "203.0.113.0/24");
  assert.equal(row.block.subscriptionRef, "sub-1");
  assert.equal(row.block.renewsAt?.toISOString(), "2026-10-20T00:00:00.000Z");
});

test("without a payment method nothing is checked out", async () => {
  const kept = paymentMethods;
  paymentMethods = [];
  calls.length = 0;
  await assert.rejects(ipxo.orderBlock("198.51.100.0/24"), /payment method.*nothing was ordered/);
  // Not even added to the cart: a later order would have paid for it too.
  assert.ok(!calls.some((c) => c.url.endsWith("/cart/items") || c.url.endsWith("/checkout")));
  paymentMethods = kept;
  cartItems = [{}, {}];
  await assert.rejects(ipxo.orderBlock("198.51.100.0/24"), /already holds other items/);
  assert.ok(!calls.some((c) => c.url.endsWith("/checkout")));
  cartItems = [{}];
  await assert.rejects(ipxo.orderBlock("10.0.0.0/24"), /public/);
});

test("letter of authorisation: the AS is validated first, then ordered with ROA, RADB and route", async () => {
  const [{ block }] = await ipxo.listIpBlocks();
  await configure({ asn: "64999" });
  calls.length = 0;
  await assert.rejects(ipxo.requestLoa(block.id), /ASN is not valid/);
  assert.ok(!calls.some((c) => c.url.endsWith("/cart/items")));
  await configure();
  await ipxo.requestLoa(block.id);
  const item = JSON.parse(calls.find((c) => c.url.endsWith("/cart/items"))!.body);
  assert.equal(item.product_type, "loa");
  assert.deepEqual(item.product_fields.subnets, ["203.0.113.0/24"]);
  assert.equal(item.product_fields.asn, 64500);
  assert.equal(item.product_fields.company_name, "Aster Srl");
  assert.deepEqual(item.product_options.selection, { roa: "yes", radb: "yes", route: "yes" });
  const [after] = await ipxo.listIpBlocks();
  assert.equal(after.block.loaStatus, "requested");
  // The LOA subscription later confirms it.
  subscriptions = { data: [...(subscriptions as { data: unknown[] }).data, { uuid: "sub-loa", items: [{ product_type: "loa", product_fields: { subnets: ["203.0.113.0/24"] } }] }] };
  await ipxo.syncIpxoBlocks();
  assert.equal((await ipxo.listIpBlocks())[0].block.loaStatus, "active");
});

test("a leased block becomes a pool on own servers, and addresses are booked by hand", async () => {
  const db = await dbm.getDb();
  const [{ block }] = await ipxo.listIpBlocks();
  await assert.rejects(ipxo.blockToPool(block.id, { provider: "hetzner", region: "fsn1" }), /Hetzner does not announce/);
  const poolId = await ipxo.blockToPool(block.id, { provider: "own", region: "milan-dc1" });
  await assert.rejects(ipxo.blockToPool(block.id, { provider: "own", region: "milan-dc1" }), /already has a pool/);
  const [pool] = await db.select().from(dbm.schema.ipPools).where(eq(dbm.schema.ipPools.id, poolId));
  assert.equal(pool.cidr, "203.0.113.0/24");
  assert.equal(pool.autoLease, false);
  const [own] = await db.insert(dbm.schema.nodes).values({ name: "metal-1", tokenHash: "h1" }).returning();
  const [cloudNode] = await db.insert(dbm.schema.nodes).values({ name: "cloud-1", tokenHash: "h2", provider: "gcp" }).returning();
  const first = await pools.assignAddress(poolId, own.id);
  const second = await pools.assignAddress(poolId, own.id);
  assert.notEqual(first, second);
  assert.match(first, /^203\.0\.113\.\d+$/);
  await assert.rejects(pools.assignAddress(poolId, cloudNode.id), /own servers/);
  // Taking an assignment back needs no provider call.
  const [lease] = await db.select().from(dbm.schema.ipLeases).where(eq(dbm.schema.ipLeases.address, first));
  await pools.releaseAddress(lease.id);
  assert.equal(await pools.assignAddress(poolId, own.id), first);
});

test("when the lease ends the block is marked and its pool stops; an unreadable answer changes nothing", async () => {
  const db = await dbm.getDb();
  subscriptions = { unexpected: true };
  await assert.rejects(ipxo.syncIpxoBlocks(), /does not understand/);
  assert.equal((await ipxo.listIpBlocks())[0].block.status, "active");
  const [{ block }] = await ipxo.listIpBlocks();
  await db.update(dbm.schema.ipPools).set({ autoLease: true }).where(eq(dbm.schema.ipPools.id, block.poolId!));
  subscriptions = { data: [] };
  assert.deepEqual(await ipxo.syncIpxoBlocks(), { active: 0, ended: 1 });
  const [after] = await ipxo.listIpBlocks();
  assert.equal(after.block.status, "ended");
  const [pool] = await db.select().from(dbm.schema.ipPools).where(eq(dbm.schema.ipPools.id, block.poolId!));
  assert.equal(pool.autoLease, false);
  await assert.rejects(ipxo.requestLoa(block.id), /not leased any more/);
  // Switched off: the daily run does not call IPXO at all.
  await configure({ enabled: false });
  calls.length = 0;
  assert.deepEqual(await ipxo.syncIpxoBlocks(), { active: 0, ended: 0 });
  assert.equal(calls.length, 0);
});
