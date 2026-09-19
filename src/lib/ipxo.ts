import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { createIpPool } from "./ip-pools";
import { isPublicCidr } from "./ipam";
import { getSettings, type Settings } from "./settings";

/**
 * IPXO: the marketplace IPv4 blocks are leased from. The administrator's own
 * app key searches the market, orders a block, asks for the letter of
 * authorisation and follows the subscriptions; an active block becomes an
 * address pool. Requests follow developer.ipxo.com; responses are read
 * loosely, because their shapes are not published.
 */

type Http = typeof fetch;
let http: Http = (...args) => fetch(...args);
export const setIpxoHttpForTests = (fake: Http) => {
  http = fake;
  tokens.clear();
};

export class IpxoError extends Error {}

const TOKEN_URL = "https://hydra.ipxo.com/oauth2/token";
const API = "https://apigw.ipxo.com";
const tokens = new Map<string, { token: string; until: number }>();

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
/** The list inside a response: the body itself, or its `data` / `items` / `results`. */
const list = (v: unknown): Json[] | null => {
  if (Array.isArray(v)) return v.map(obj);
  for (const key of ["data", "items", "results"]) {
    const inner = obj(v)[key];
    if (Array.isArray(inner)) return inner.map(obj);
    if (Array.isArray(obj(inner).data)) return (obj(inner).data as unknown[]).map(obj);
  }
  return null;
};
const pick = (o: Json, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== "");
const ref = (o: Json) => String(pick(o, "uuid", "id") ?? "");

async function account(): Promise<Settings<"ipxo">> {
  const s = await getSettings("ipxo");
  if (!s.enabled || !s.clientId || !s.clientSecret || !s.tenantUuid) throw new IpxoError("Enter your IPXO app key first");
  return s;
}

async function accessToken(s: Settings<"ipxo">): Promise<string> {
  const cached = tokens.get(s.clientId);
  if (cached && cached.until > Date.now()) return cached.token;
  const res = await http(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: s.clientId, client_secret: s.clientSecret, scope: s.scopes }).toString() }).catch(() => null);
  if (!res) throw new IpxoError("IPXO could not be reached");
  const body = obj(await res.json().catch(() => ({})));
  if (!res.ok || typeof body.access_token !== "string") throw new IpxoError(`IPXO refused the app key: ${String(pick(body, "error_description", "error") ?? res.status)}`);
  tokens.set(s.clientId, { token: body.access_token, until: Date.now() + Math.max(30, Number(body.expires_in ?? 300) - 60) * 1000 });
  return body.access_token;
}

async function call(s: Settings<"ipxo">, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await http(`${API}${path.replace("{tenant}", encodeURIComponent(s.tenantUuid))}`, { method, headers: { Authorization: `Bearer ${await accessToken(s)}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
  if (!res) throw new IpxoError("IPXO could not be reached");
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON: only the status matters.
  }
  if (!res.ok) throw new IpxoError(`IPXO: ${String(pick(obj(parsed), "message", "detail", "error") ?? `HTTP ${res.status}`).slice(0, 200)}`);
  return parsed;
}

export async function testIpxo(): Promise<string> {
  const s = await account();
  await call(s, "GET", "/billing/v1/{tenant}/market/search?prefix_length=24&limit=1");
  return "Connected";
}

export type MarketBlock = { cidr: string; monthly: number | null; currency: string; country: string };

export async function searchMarket(input: { prefixLength: number; country?: string }): Promise<MarketBlock[]> {
  const s = await account();
  const prefix = Math.round(input.prefixLength);
  if (!(prefix >= 16 && prefix <= 24)) throw new IpxoError("Blocks on the market go from /16 to /24");
  const country = (input.country ?? "").trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new IpxoError("The country is a two-letter code, such as IT");
  const query = new URLSearchParams({ prefix_length: String(prefix), limit: "20", sort: "price" });
  if (country) query.set("geo_country_code", country);
  const rows = list(await call(s, "GET", `/billing/v1/{tenant}/market/search?${query}`));
  if (!rows) throw new IpxoError("IPXO answered in a form this panel does not understand");
  return rows.flatMap((r) => {
    const cidr = `${String(r.address ?? "")}/${String(pick(r, "prefix_length", "cidr") ?? "")}`;
    if (!isPublicCidr(cidr)) return [];
    const price = Number(pick(r, "price", "monthly_price", "price_per_month"));
    return [{ cidr, monthly: Number.isFinite(price) ? price : null, currency: String(pick(r, "currency") ?? "USD"), country: String(pick(r, "geo_country_code", "country_code", "country") ?? "") }];
  });
}

/** What paying needs, looked up before anything enters the cart: an order that cannot be paid must not leave an item behind for the next checkout to buy. */
async function payer(s: Settings<"ipxo">) {
  const addresses = list(await call(s, "GET", "/ecommerce/public/{tenant}/addresses?filter%5Baddressable_type%5D=customer")) ?? [];
  const methods = list(await call(s, "GET", "/ecommerce/public/{tenant}/payment-methods?per_page=999")) ?? [];
  const method = methods.find((m) => m.is_default === true || m.default === true) ?? methods[0];
  if (!addresses[0] || !ref(addresses[0])) throw new IpxoError("Add a billing address to your IPXO account first: nothing was ordered");
  if (!method || !ref(method)) throw new IpxoError("Add a payment method to your IPXO account first: nothing was ordered");
  return { address: ref(addresses[0]), method: ref(method) };
}

/** Adds one item and pays the cart. A cart holding anything else is left alone: it would be bought together with it. */
async function buy(s: Settings<"ipxo">, item: unknown) {
  const pay = await payer(s);
  await call(s, "POST", "/billing/v1/{tenant}/cart/items", item);
  const cart = obj(await call(s, "GET", "/ecommerce/public/{tenant}/cart"));
  const inner = obj(cart.data);
  const cartId = ref(cart) || ref(inner);
  if (!cartId) throw new IpxoError("IPXO did not return the cart: nothing was ordered. Check the cart in the IPXO portal");
  const items = [cart.items, inner.items].find(Array.isArray) as unknown[] | undefined;
  if (items && items.length > 1) throw new IpxoError("Your IPXO cart already holds other items: empty it in the IPXO portal, nothing was ordered");
  const base = `/ecommerce/public/{tenant}/cart/${encodeURIComponent(cartId)}`;
  await call(s, "POST", `${base}/addresses/${encodeURIComponent(pay.address)}`, { type: "billing" });
  await call(s, "PATCH", `${base}/payment-method/${encodeURIComponent(pay.method)}`, {});
  await call(s, "POST", `${base}/checkout`, {});
}

/** Orders a block found on the market, monthly. This spends the company's money: only an administrator's explicit action reaches it. */
export async function orderBlock(cidr: string, actorId: string | null = null) {
  const s = await account();
  if (!isPublicCidr(cidr)) throw new IpxoError("Not a public IPv4 block");
  const [address, prefix] = cidr.split("/");
  await buy(s, { product_type: "ipv4", billing_cycle: 1, product_fields: { address, cidr: Number(prefix) } });
  await audit(actorId, "ipblock.ordered", "ip_block", "", { cidr });
  await syncIpxoBlocks().catch(() => null);
}

const CIDR = /\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g;
/** Every block named anywhere in a subscription: as "a.b.c.d/nn", or as an address next to its prefix length. */
function blocksIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") for (const m of value.match(CIDR) ?? []) if (isPublicCidr(m)) found.add(m);
  if (Array.isArray(value)) for (const v of value) blocksIn(v, found);
  else if (value && typeof value === "object") {
    const o = value as Json;
    const pair = `${String(o.address ?? "")}/${String(pick(o, "cidr", "prefix_length") ?? "")}`;
    if (isPublicCidr(pair)) found.add(pair);
    for (const v of Object.values(o)) blocksIn(v, found);
  }
  return found;
}
const dateOf = (o: Json) => {
  const raw = pick(o, "next_billing_at", "next_billing_date", "renews_at", "current_period_end", "period_end", "ends_at");
  const d = raw ? new Date(String(raw)) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/**
 * Follows the account's active subscriptions: new blocks appear, blocks whose
 * lease ended are marked and their pool stops handing out addresses (the ones
 * in use are left to the administrator: sites still answer from them).
 */
export async function syncIpxoBlocks(): Promise<{ active: number; ended: number }> {
  const s = await getSettings("ipxo");
  if (!s.enabled) return { active: 0, ended: 0 };
  const subs = list(await call(await account(), "POST", "/ecommerce/public/{tenant}/subscriptions/search", { filter: { status: "active" }, per_page: "100" }));
  // An answer we cannot read must never look like "every lease ended".
  if (!subs) throw new IpxoError("IPXO answered in a form this panel does not understand");
  const db = await getDb();
  const now = new Date();
  const seen = new Set<string>();
  const authorised = new Set<string>();
  for (const sub of subs) {
    const isLoa = /"(?:product_type|type|product)"\s*:\s*"loa"/i.test(JSON.stringify(sub));
    for (const cidr of blocksIn(sub)) {
      if (isLoa) {
        authorised.add(cidr);
        continue;
      }
      seen.add(cidr);
      await db.insert(schema.ipBlocks).values({ cidr, subscriptionRef: ref(sub), renewsAt: dateOf(sub), syncedAt: now }).onConflictDoUpdate({ target: schema.ipBlocks.cidr, set: { status: "active", subscriptionRef: ref(sub), renewsAt: dateOf(sub), syncedAt: now } });
    }
  }
  for (const cidr of authorised) await db.update(schema.ipBlocks).set({ loaStatus: "active" }).where(eq(schema.ipBlocks.cidr, cidr));
  let ended = 0;
  for (const block of await db.select().from(schema.ipBlocks).where(and(eq(schema.ipBlocks.source, "ipxo"), eq(schema.ipBlocks.status, "active")))) {
    if (seen.has(block.cidr)) continue;
    ended++;
    await db.update(schema.ipBlocks).set({ status: "ended", syncedAt: now }).where(eq(schema.ipBlocks.id, block.id));
    if (block.poolId) await db.update(schema.ipPools).set({ autoLease: false }).where(eq(schema.ipPools.id, block.poolId));
    await audit(null, "ipblock.ended", "ip_block", block.id, { cidr: block.cidr });
  }
  return { active: seen.size, ended };
}

/** Asks IPXO for the letter of authorisation (with ROA, RADB and route objects) so the AS in the settings may announce the block. */
export async function requestLoa(blockId: string, actorId: string | null = null) {
  const s = await account();
  const asn = Number(s.asn.replace(/^AS/i, ""));
  if (!Number.isInteger(asn) || asn < 1 || asn > 4294967295) throw new IpxoError("Enter the AS number that will announce the block");
  if (!s.companyName.trim()) throw new IpxoError("Enter the company name for the letter of authorisation");
  const db = await getDb();
  const [block] = await db.select().from(schema.ipBlocks).where(eq(schema.ipBlocks.id, blockId));
  if (!block || block.status !== "active") throw new IpxoError("This block is not leased any more");
  await call(s, "POST", `/billing/v1/{tenant}/asn/validate/${asn}`, { subnets: [block.cidr] });
  await buy(s, {
    product_type: "loa",
    billing_cycle: 0,
    product_fields: { max_length: 24, company_name: s.companyName.trim(), asn, info: "", create_whois_inetnum: true, whois_data_exposed: false, subnets: [block.cidr] },
    product_options: { selection: { roa: "yes", radb: "yes", route: "yes" } },
  });
  await db.update(schema.ipBlocks).set({ asn, loaStatus: "requested" }).where(eq(schema.ipBlocks.id, block.id));
  await audit(actorId, "ipblock.loa_requested", "ip_block", block.id, { cidr: block.cidr, asn });
}

/** Turns a leased block into an address pool: on Google Cloud (once brought there as BYOIP) or on the company's own servers. */
export async function blockToPool(blockId: string, input: { provider: string; region: string }, actorId: string | null = null): Promise<string> {
  const db = await getDb();
  const [block] = await db.select().from(schema.ipBlocks).where(eq(schema.ipBlocks.id, blockId));
  if (!block || block.status !== "active") throw new IpxoError("This block is not leased any more");
  if (block.poolId) throw new IpxoError("This block already has a pool");
  const poolId = await createIpPool({ name: `IPXO ${block.cidr}`, provider: input.provider, region: input.region, mode: "block", cidr: block.cidr, autoLease: input.provider !== "own" }, actorId);
  await db.update(schema.ipBlocks).set({ poolId }).where(eq(schema.ipBlocks.id, block.id));
  return poolId;
}

export async function listIpBlocks() {
  const db = await getDb();
  return db.select({ block: schema.ipBlocks, pool: schema.ipPools.name }).from(schema.ipBlocks).leftJoin(schema.ipPools, eq(schema.ipPools.id, schema.ipBlocks.poolId)).orderBy(schema.ipBlocks.cidr);
}
