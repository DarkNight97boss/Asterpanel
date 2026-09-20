import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { BILLING_CYCLES, type BillingCycle, type CartItemData } from "@/db/schema";
import { BillingError, placeLines, priceLines, type OrderLine } from "./billing";
import { decryptJson, encryptJson } from "./crypto";
import { DomainError, MAX_YEARS, prepareDomains, type BasketItem } from "./domains";
import { DOMAIN_RE } from "./format";

/**
 * The cart of a company: catalogue products (with their options) and domains,
 * checked out as one order with one invoice. Prices are never stored: they are
 * worked out when the cart is shown and again at checkout, so a price change
 * or a product taken off sale is always reflected.
 */

export class CartError extends Error {}
export const MAX_CART = 20;

async function add(companyId: string, data: CartItemData) {
  const db = await getDb();
  const items = await db.select({ id: schema.cartItems.id }).from(schema.cartItems).where(eq(schema.cartItems.companyId, companyId));
  if (items.length >= MAX_CART) throw new CartError(`The cart holds at most ${MAX_CART} items`);
  await db.insert(schema.cartItems).values({ companyId, data });
}

export async function addProduct(companyId: string, input: { productId: string; cycle: string; domain: string; addonIds?: string[]; options?: Record<string, string> }) {
  const cycle = BILLING_CYCLES.find((c) => c === input.cycle) as BillingCycle | undefined;
  const domain = input.domain.trim().toLowerCase();
  if (!cycle) throw new CartError("Billing cycle not available for this product");
  if (domain && !DOMAIN_RE.test(domain)) throw new CartError("Enter a valid domain, e.g. example.com");
  const data: CartItemData = { kind: "product", productId: input.productId, cycle, domain, addonIds: input.addonIds ?? [], options: input.options ?? {} };
  // Priced once now, so something that cannot be ordered never enters the cart.
  await priceLines([toLine(data)], companyId).catch((err) => {
    throw err instanceof BillingError ? new CartError(err.message) : err;
  });
  await add(companyId, data);
}

export async function addDomains(companyId: string, clientId: string, items: BasketItem[]) {
  // Same checks as an order (extension on sale, not already in an account, still free), minus the registrant, asked at checkout.
  const db = await getDb();
  const mine = (await db.select().from(schema.cartItems).where(eq(schema.cartItems.companyId, companyId))).flatMap((i) => (i.data.kind === "domain" ? [i.data.domain] : []));
  for (const item of items) {
    const domain = String(item.domain).trim().toLowerCase();
    if (mine.includes(domain)) continue;
    await prepareDomains({ clientId, companyId, items: [item], contact: PLACEHOLDER_CONTACT }).catch((err) => {
      throw err instanceof DomainError ? new CartError(err.message) : err;
    });
    await add(companyId, { kind: "domain", domain, action: item.action, years: Math.min(MAX_YEARS, Math.max(1, Math.round(item.years ?? 1))), authCode: item.authCode ? encryptJson(item.authCode) : "" });
    mine.push(domain);
  }
}

/** A registrant that passes validation, used only to check a domain before the real one is known. Never stored. */
const PLACEHOLDER_CONTACT = { firstName: "Check", lastName: "Only", organization: "", state: "RM", email: "check@example.com", phone: "+39.0612345678", address: "Via Roma 1", city: "Roma", zip: "00100", country: "IT", taxCode: "RSSMRA80A01H501U" };

const toLine = (data: Extract<CartItemData, { kind: "product" }>): OrderLine => ({ productId: data.productId, cycle: data.cycle, domain: data.domain, addonIds: data.addonIds, options: data.options });
const toBasket = (data: Extract<CartItemData, { kind: "domain" }>): BasketItem => ({ domain: data.domain, action: data.action, years: data.years, authCode: data.authCode ? decryptJson<string>(data.authCode, "") : undefined });

export type CartView = { items: { id: string; kind: "product" | "domain"; label: string; price: number; setup: number; recurring: number; error?: string }[]; subtotal: number; hasDomains: boolean; tlds: string[] };

/** The cart with today's prices. An item that can no longer be ordered is shown with the reason instead of breaking the page. */
export async function viewCart(companyId: string, clientId: string): Promise<CartView> {
  const db = await getDb();
  const rows = await db.select().from(schema.cartItems).where(eq(schema.cartItems.companyId, companyId)).orderBy(asc(schema.cartItems.createdAt));
  const items: CartView["items"] = [];
  for (const row of rows) {
    try {
      const lines = row.data.kind === "product" ? [toLine(row.data)] : (await prepareDomains({ clientId, companyId, items: [toBasket(row.data)], contact: PLACEHOLDER_CONTACT, offline: true })).lines;
      const [p] = await priceLines(lines, companyId);
      items.push({ id: row.id, kind: row.data.kind, label: p.label, price: p.price, setup: p.setup, recurring: p.line.pricing?.recurring ?? p.price });
    } catch (err) {
      if (!(err instanceof BillingError) && !(err instanceof DomainError)) throw err;
      items.push({ id: row.id, kind: row.data.kind, label: row.data.domain || "—", price: 0, setup: 0, recurring: 0, error: err.message });
    }
  }
  const domains = rows.flatMap((r) => (r.data.kind === "domain" ? [r.data.domain] : []));
  return { items, subtotal: items.reduce((sum, i) => sum + i.price + i.setup, 0), hasDomains: domains.length > 0, tlds: [...new Set(domains.map((d) => d.split(".").slice(1).join(".")))] };
}

export async function removeFromCart(companyId: string, itemId: string) {
  await (await getDb()).delete(schema.cartItems).where(and(eq(schema.cartItems.id, itemId), eq(schema.cartItems.companyId, companyId)));
}

/** Everything in the cart on one order and one invoice. The cart is emptied only once the order exists. */
export async function checkoutCart(input: { companyId: string; clientId: string; coupon?: string; contact: Record<string, unknown>; ip?: string }): Promise<{ invoiceId: string }> {
  const db = await getDb();
  const rows = await db.select().from(schema.cartItems).where(eq(schema.cartItems.companyId, input.companyId)).orderBy(asc(schema.cartItems.createdAt));
  if (!rows.length) throw new CartError("Your cart is empty");
  const productLines = rows.flatMap((r) => (r.data.kind === "product" ? [toLine(r.data)] : []));
  const basket = rows.flatMap((r) => (r.data.kind === "domain" ? [toBasket(r.data)] : []));
  try {
    const domains = basket.length ? await prepareDomains({ clientId: input.clientId, companyId: input.companyId, items: basket, contact: input.contact }) : null;
    // Domains last: their services are the tail of `serviceIds`.
    const { invoiceId, serviceIds } = await placeLines({ clientId: input.clientId, companyId: input.companyId, ip: input.ip, coupon: input.coupon, lines: [...productLines, ...(domains?.lines ?? [])] });
    if (domains) await domains.attach(serviceIds.slice(productLines.length));
    await db.delete(schema.cartItems).where(eq(schema.cartItems.companyId, input.companyId));
    return { invoiceId };
  } catch (err) {
    if (err instanceof BillingError || err instanceof DomainError) throw new CartError(err.message);
    throw err;
  }
}

export const cartCount = async (companyId: string) => (await (await getDb()).select({ id: schema.cartItems.id }).from(schema.cartItems).where(eq(schema.cartItems.companyId, companyId))).length;
