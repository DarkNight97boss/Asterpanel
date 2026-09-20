import "server-only";
import { and, asc, eq, inArray, lt, or, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { getRegistrar, RegistrarError, type DomainContact, type Http, type RegistrarCredentials, type RegistrarModule } from "@/modules/registrars";
import { audit } from "./audit";
import { emitEvent } from "./webhooks";
import { decryptJson, encryptJson } from "./crypto";
import { getSettings } from "./settings";

/**
 * Domain names: search, order, registration and management through the
 * registrar modules. A domain is billed like any other service (yearly), so
 * invoices, reminders and renewals come from the billing engine; this file is
 * what the `domain` provisioning module calls when those invoices are paid.
 */

export class DomainError extends Error {}

let http: Http = (...args) => fetch(...args);
export const setRegistrarHttpForTests = (fake: Http) => void (http = fake);

// ─── Names, phones, contacts ─────────────────────────────────────────────────

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Splits a name against the TLDs on sale (longest suffix wins: `co.uk` before `uk`). */
export function splitDomain(input: string, tlds: string[]): { name: string; sld: string; tld: string } | null {
  const name = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  const tld = [...tlds].sort((a, b) => b.length - a.length).find((t) => name.endsWith(`.${t}`));
  if (!tld) return null;
  const sld = name.slice(0, -tld.length - 1);
  // One label only: sub.example.com is not something a registry sells.
  return LABEL.test(sld) && sld.length >= 2 ? { name, sld, tld } : null;
}

/** Country calling codes, to split `+390612345678` into `+39.0612345678` as registries want it. */
const CALLING = new Set(
  "1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98 211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 370 371 372 373 374 375 376 377 378 380 381 382 383 385 386 387 389 420 421 423 500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 850 852 853 855 856 880 886 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 992 993 994 995 996 998".split(" "),
);

export function normalizePhone(raw: string): string {
  const compact = raw.trim().replace(/^00/, "+").replace(/[\s().-]/g, "");
  const m = /^\+(\d{7,15})$/.exec(compact);
  if (!m) throw new DomainError("Enter the phone number in international format, for example +39 06 1234567");
  const cc = [1, 2, 3].map((n) => m[1].slice(0, n)).find((c) => CALLING.has(c));
  if (!cc) throw new DomainError("The phone number starts with an unknown country code");
  return `+${cc}.${m[1].slice(cc.length)}`;
}

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n<>]*$/);
const contactSchema = z.object({
  firstName: line(60),
  lastName: line(60),
  organization: z.string().trim().max(100).regex(/^[^\r\n<>]*$/),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string(),
  address: line(200),
  city: line(80),
  zip: line(20),
  state: z.string().trim().max(80).regex(/^[^\r\n<>]*$/),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  taxCode: z.string().trim().toUpperCase().max(40).regex(/^[A-Z0-9]*$/),
});

export function cleanContact(input: Record<string, unknown>, domain = ""): DomainContact {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) throw new DomainError(`Check the registrant details: ${parsed.error.issues[0].path.join(".")}`);
  if (domain.endsWith(".it") && !parsed.data.taxCode) throw new DomainError("The .it registry requires the tax code (codice fiscale or VAT number) of the registrant");
  return { ...parsed.data, phone: normalizePhone(parsed.data.phone) };
}

export function cleanNameservers(input: string[]): string[] {
  const list = [...new Set(input.map((n) => n.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))];
  if (list.length < 2 || list.length > 6) throw new DomainError("Enter between 2 and 6 name servers");
  for (const ns of list) if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(ns)) throw new DomainError(`“${ns}” is not a valid name server`);
  return list;
}

// ─── Registrars ──────────────────────────────────────────────────────────────

async function account(registrarId: string): Promise<{ mod: RegistrarModule; creds: RegistrarCredentials }> {
  const mod = getRegistrar(registrarId);
  const creds = (await getSettings("registrars")).accounts[registrarId];
  if (!mod || !creds || !Object.values(creds).some(Boolean)) throw new DomainError("This registrar is not configured");
  return { mod, creds };
}

export async function testRegistrar(registrarId: string): Promise<string> {
  const { mod, creds } = await account(registrarId);
  return mod.test(creds, http);
}

const readable = (err: unknown) => (err instanceof RegistrarError || err instanceof DomainError ? err.message : "The registrar could not be reached");

// ─── Search ──────────────────────────────────────────────────────────────────

export type SearchHit = { domain: string; tld: string; available: boolean | null; registerPrice: number; renewPrice: number; transferPrice: number; /** The list price, when `registerPrice` is a promotion. */ listPrice?: number };

export const MAX_YEARS = 5;

/** What the first year of a new registration costs today. */
export const firstYearPrice = (tld: { registerPrice: number; promoPrice: number | null; promoUntil: Date | null }, now = new Date()) => (tld.promoPrice != null && (!tld.promoUntil || tld.promoUntil > now) ? tld.promoPrice : tld.registerPrice);

/** `example` checks every TLD on sale; `example.it` puts that one first. */
export async function searchDomains(query: string): Promise<SearchHit[]> {
  const db = await getDb();
  const tlds = await db.select().from(schema.domainTlds).where(eq(schema.domainTlds.enabled, true)).orderBy(asc(schema.domainTlds.sort), asc(schema.domainTlds.tld));
  if (!tlds.length) return [];
  const exact = splitDomain(query, tlds.map((t) => t.tld));
  const sld = exact?.sld ?? query.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(".")[0];
  if (!LABEL.test(sld) || sld.length < 2) throw new DomainError("Use letters, numbers and dashes only, at least two characters");

  const ordered = [...tlds].sort((a, b) => Number(b.tld === exact?.tld) - Number(a.tld === exact?.tld)).slice(0, 12);
  const taken = new Set((await db.select({ name: schema.domainNames.name }).from(schema.domainNames).where(and(inArray(schema.domainNames.name, ordered.map((t) => `${sld}.${t.tld}`)), inArray(schema.domainNames.status, ["pending", "active", "transferring"])))).map((d) => d.name));
  const hits = new Map<string, boolean | null>();
  await Promise.all(
    [...Map.groupBy(ordered, (t) => t.registrar)].map(async ([registrarId, group]) => {
      const names = group.map((t) => `${sld}.${t.tld}`);
      try {
        const { mod, creds } = await account(registrarId);
        for (const r of await mod.check(creds, names, http)) hits.set(r.domain, r.available);
      } catch {
        for (const n of names) hits.set(n, null); // unknown: shown as "could not check"
      }
    }),
  );
  return ordered.map((t) => ({ domain: `${sld}.${t.tld}`, tld: t.tld, available: taken.has(`${sld}.${t.tld}`) ? false : (hits.get(`${sld}.${t.tld}`) ?? null), registerPrice: firstYearPrice(t), listPrice: firstYearPrice(t) < t.registerPrice ? t.registerPrice : undefined, renewPrice: t.renewPrice, transferPrice: t.transferPrice }));
}

/** Nearby names for when the wanted one is taken: common prefixes and suffixes, nothing clever. */
export function suggestNames(sld: string): string[] {
  const base = sld.replace(/-+/g, "-").slice(0, 40);
  const out = [`get${base}`, `${base}app`, `${base}hq`, `my${base}`, `${base}online`, `${base}-web`, `the${base}`, `${base}studio`];
  return [...new Set(out)].filter((n) => LABEL.test(n) && n !== sld);
}

/** Availability of the suggestions on the most prominent TLDs on sale. One registrar call per registrar. */
export async function suggestDomains(query: string): Promise<SearchHit[]> {
  const db = await getDb();
  const tlds = (await db.select().from(schema.domainTlds).where(eq(schema.domainTlds.enabled, true)).orderBy(asc(schema.domainTlds.sort), asc(schema.domainTlds.tld))).slice(0, 2);
  const sld = splitDomain(query, tlds.map((t) => t.tld))?.sld ?? query.trim().toLowerCase().split(".")[0];
  if (!tlds.length || !LABEL.test(sld)) return [];
  const hits: SearchHit[] = [];
  await Promise.all(
    [...Map.groupBy(tlds, (t) => t.registrar)].map(async ([registrarId, group]) => {
      try {
        const { mod, creds } = await account(registrarId);
        const names = group.flatMap((t) => suggestNames(sld).slice(0, 6).map((n) => `${n}.${t.tld}`));
        for (const r of await mod.check(creds, names, http)) {
          const t = group.find((g) => r.domain.endsWith(`.${g.tld}`))!;
          if (r.available) hits.push({ domain: r.domain, tld: t.tld, available: true, registerPrice: firstYearPrice(t), renewPrice: t.renewPrice, transferPrice: t.transferPrice });
        }
      } catch {
        // Suggestions are a nicety: a registrar that does not answer simply offers none.
      }
    }),
  );
  return hits.slice(0, 8);
}

// ─── Ordering ────────────────────────────────────────────────────────────────

/** The hidden catalogue entry every domain service hangs off. */
async function domainProduct(): Promise<string> {
  const db = await getDb();
  const [existing] = await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.slug, "domain-name"));
  if (existing) return existing.id;
  const [group] = await db.insert(schema.productGroups).values({ slug: "domains", name: "Domain names", hidden: true }).onConflictDoNothing().returning({ id: schema.productGroups.id });
  const groupId = group?.id ?? (await db.select({ id: schema.productGroups.id }).from(schema.productGroups).where(eq(schema.productGroups.slug, "domains")))[0].id;
  const [product] = await db.insert(schema.products).values({ groupId, slug: "domain-name", name: "Domain name", module: "domain", hidden: true, requiresDomain: true, pricing: { annually: 0 } }).returning({ id: schema.products.id });
  return product.id;
}

export const MAX_BASKET = 20;
export type BasketItem = { domain: string; action: "register" | "transfer"; authCode?: string; /** Registrations only: 1 to 5 years paid up front. */ years?: number };

/**
 * One or more domains on a single invoice, all for the same registrant.
 * Everything is checked before anything is written: one bad line refuses the
 * whole basket, naming the domain, instead of leaving a half-made order.
 */
export async function orderDomains(input: { clientId: string; companyId: string | null; items: BasketItem[]; contact: Record<string, unknown>; ip?: string }): Promise<{ invoiceId: string; domainIds: string[] }> {
  if (!input.items.length) throw new DomainError("Choose at least one domain");
  if (input.items.length > MAX_BASKET) throw new DomainError(`At most ${MAX_BASKET} domains per order`);
  const db = await getDb();
  const tlds = await db.select().from(schema.domainTlds).where(eq(schema.domainTlds.enabled, true));
  const settings = await getSettings("registrars");

  const lines: { name: string; tld: (typeof tlds)[number]; contact: ReturnType<typeof cleanContact>; authCode: string; existing: typeof schema.domainNames.$inferSelect | undefined; years: number; action: BasketItem["action"] }[] = [];
  for (const item of input.items) {
    const parts = splitDomain(item.domain, tlds.map((t) => t.tld));
    if (!parts) throw new DomainError(`${String(item.domain).slice(0, 80)}: this extension is not on sale`);
    if (lines.some((l) => l.name === parts.name)) continue; // the same name twice is one domain
    const tld = tlds.find((t) => t.tld === parts.tld)!;
    const contact = cleanContact(input.contact, parts.name);
    const authCode = String(item.authCode ?? "").trim();
    if (item.action === "transfer" && (!authCode || authCode.length > 100)) throw new DomainError(`${parts.name}: enter the transfer (EPP / auth) code given by the current registrar`);
    const [existing] = await db.select().from(schema.domainNames).where(eq(schema.domainNames.name, parts.name));
    if (existing && !["failed", "cancelled", "expired"].includes(existing.status)) throw new DomainError(`${parts.name}: this domain is already in an account`);
    const years = item.action === "register" ? Math.min(MAX_YEARS, Math.max(1, Math.round(item.years ?? 1))) : 1;
    lines.push({ name: parts.name, tld, contact, authCode, existing, years, action: item.action });
  }
  // Availability, one call per registrar.
  for (const registrar of new Set(lines.filter((l) => l.action === "register").map((l) => l.tld.registrar))) {
    const names = lines.filter((l) => l.action === "register" && l.tld.registrar === registrar).map((l) => l.name);
    const { mod, creds } = await account(registrar);
    const hits = await mod.check(creds, names, http).catch((err) => {
      throw new DomainError(readable(err));
    });
    const gone = names.find((n) => !hits.find((h) => h.domain === n)?.available);
    if (gone) throw new DomainError(`${gone}: this domain is no longer available`);
  }
  for (const registrar of new Set(lines.filter((l) => l.action === "transfer").map((l) => l.tld.registrar))) await account(registrar);

  const { placeBundle } = await import("./billing");
  const { invoiceId, serviceIds } = await placeBundle({
    clientId: input.clientId,
    companyId: input.companyId,
    productId: await domainProduct(),
    cycle: "annually",
    ip: input.ip,
    lines: lines.map((l) => ({
      domain: l.name,
      // The promotion covers the first year; further years are at the renewal price.
      pricing: { first: l.action === "register" ? firstYearPrice(l.tld) + (l.years - 1) * l.tld.renewPrice : l.tld.transferPrice, recurring: l.tld.renewPrice, label: l.action === "register" ? "Domain registration" : "Domain transfer", period: l.years > 1 ? `${l.years} years` : undefined },
      // The transfer code is a secret of the customer's: encrypted until used.
      request: { action: l.action, years: l.years, authCode: l.authCode ? encryptJson(l.authCode) : "" },
    })),
  });
  const domainIds: string[] = [];
  for (const [i, l] of lines.entries()) {
    const row = { companyId: input.companyId, clientId: input.clientId, serviceId: serviceIds[i], registrar: l.tld.registrar, status: "pending" as const, statusMessage: "", contact: l.contact as unknown as Record<string, string>, nameservers: settings.nameservers, expiresAt: null };
    const [domain] = l.existing
      ? await db.update(schema.domainNames).set(row).where(eq(schema.domainNames.id, l.existing.id)).returning({ id: schema.domainNames.id })
      : await db.insert(schema.domainNames).values({ ...row, name: l.name }).returning({ id: schema.domainNames.id });
    domainIds.push(domain.id);
  }
  return { invoiceId, domainIds };
}

export async function orderDomain(input: { clientId: string; companyId: string | null; domain: string; action: "register" | "transfer"; authCode?: string; contact: Record<string, unknown>; ip?: string; years?: number }): Promise<{ invoiceId: string; domainId: string }> {
  const { invoiceId, domainIds } = await orderDomains({ clientId: input.clientId, companyId: input.companyId, contact: input.contact, ip: input.ip, items: [{ domain: input.domain, action: input.action, authCode: input.authCode, years: input.years }] });
  return { invoiceId, domainId: domainIds[0] };
}

/** `domain code` lines of a bulk transfer. */
export function parseTransferLines(text: string): BasketItem[] {
  const items: BasketItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\S+)[\s,;]+(\S.*)$/.exec(line);
    if (!m) throw new DomainError(`“${line.slice(0, 60)}”: write the domain, a space, then its transfer code`);
    items.push({ domain: m[1], action: "transfer", authCode: m[2].trim() });
  }
  return items;
}

// ─── Called by the provisioning module when invoices are paid ────────────────

async function byService(serviceId: string) {
  const db = await getDb();
  const [d] = await db.select().from(schema.domainNames).where(eq(schema.domainNames.serviceId, serviceId));
  if (!d) throw new DomainError("No domain is linked to this service");
  return d;
}

const DEFAULT_NS_HINT = "Set the default name servers in the registrar settings first";

export async function provisionDomain(serviceId: string, request: { action?: string; authCode?: string; years?: number }): Promise<void> {
  const db = await getDb();
  const d = await byService(serviceId);
  // A retry after a half-finished attempt must not register (and pay for) the name twice.
  if (d.status === "active" || d.status === "transferring") return;
  try {
    const { mod, creds } = await account(d.registrar);
    const nameservers = d.nameservers.length ? d.nameservers : (await getSettings("registrars")).nameservers;
    if (nameservers.length < 2) throw new DomainError(DEFAULT_NS_HINT);
    const contact = d.contact as unknown as DomainContact;
    if (request.action === "transfer") {
      await mod.transfer(creds, { domain: d.name, authCode: decryptJson<string>(request.authCode ?? "", ""), contact, nameservers }, http);
      await db.update(schema.domainNames).set({ status: "transferring", statusMessage: "", nameservers }).where(eq(schema.domainNames.id, d.id));
    } else {
      await mod.register(creds, { domain: d.name, years: Math.min(MAX_YEARS, Math.max(1, Number(request.years) || 1)), contact, nameservers }, http);
      await db.update(schema.domainNames).set({ status: "active", statusMessage: "", nameservers }).where(eq(schema.domainNames.id, d.id));
      emitEvent(d.companyId, "domain.registered", { domain: d.name });
    }
    await hostZone(d, nameservers).catch(() => {});
    await syncDomain(d.id).catch(() => {});
    // The next invoice follows the registry's expiry date, not the day the order happened to be paid.
    const [synced] = await db.select({ expiresAt: schema.domainNames.expiresAt }).from(schema.domainNames).where(eq(schema.domainNames.id, d.id));
    if (synced?.expiresAt && synced.expiresAt > new Date()) await db.update(schema.services).set({ nextDueDate: synced.expiresAt }).where(eq(schema.services.id, serviceId));
  } catch (err) {
    await db.update(schema.domainNames).set({ status: "failed", statusMessage: readable(err).slice(0, 300) }).where(eq(schema.domainNames.id, d.id));
    throw err;
  }
}

/** A domain pointed at our own name servers gets its DNS zone right away, ready for records. */
async function hostZone(d: typeof schema.domainNames.$inferSelect, nameservers: string[]) {
  const ours = new Set((await getSettings("dns")).nameservers);
  if (!ours.size || !nameservers.every((ns) => ours.has(ns))) return;
  const { createZone } = await import("@/platform/engine");
  await createZone(d.clientId, d.name, null, d.companyId);
}

export async function renewDomain(serviceId: string): Promise<void> {
  const db = await getDb();
  const d = await byService(serviceId);
  try {
    const { mod, creds } = await account(d.registrar);
    await mod.renew(creds, { domain: d.name, years: 1, currentExpiry: d.expiresAt }, http);
    await db.update(schema.domainNames).set({ status: "active", statusMessage: "" }).where(eq(schema.domainNames.id, d.id));
    await syncDomain(d.id).catch(() => {});
  } catch (err) {
    // Paid but not renewed: staff must see this.
    await db.update(schema.domainNames).set({ statusMessage: `Renewal failed: ${readable(err)}`.slice(0, 300) }).where(eq(schema.domainNames.id, d.id));
    throw err;
  }
}

// ─── Management ──────────────────────────────────────────────────────────────

async function manageable(domainId: string) {
  const db = await getDb();
  const [d] = await db.select().from(schema.domainNames).where(eq(schema.domainNames.id, domainId));
  if (!d) throw new DomainError("Domain not found");
  if (d.status !== "active") throw new DomainError("This domain is not active yet");
  return { d, ...(await account(d.registrar)) };
}

const wrap = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (err) {
    throw err instanceof DomainError ? err : new DomainError(readable(err));
  }
};

export async function syncDomain(domainId: string): Promise<void> {
  const db = await getDb();
  const [d] = await db.select().from(schema.domainNames).where(eq(schema.domainNames.id, domainId));
  if (!d || !["active", "transferring", "expired"].includes(d.status)) return;
  const { mod, creds } = await account(d.registrar);
  const info = await mod.info(creds, d.name, http);
  // A transfer that has completed shows up as a normal, active registration.
  const status = info.status === "unknown" || info.status === "pending" ? d.status : info.status;
  await db.update(schema.domainNames).set({ status, expiresAt: info.expiresAt ?? d.expiresAt, nameservers: info.nameservers.length ? info.nameservers : d.nameservers, locked: info.locked, syncedAt: new Date() }).where(eq(schema.domainNames.id, d.id));
}

/** Cron: refreshes the domains not looked at for a day, a few per run. */
export async function syncDueDomains(now = new Date(), limit = 25): Promise<number> {
  const db = await getDb();
  const due = await db
    .select({ id: schema.domainNames.id })
    .from(schema.domainNames)
    .where(and(inArray(schema.domainNames.status, ["active", "transferring"]), or(isNull(schema.domainNames.syncedAt), lt(schema.domainNames.syncedAt, new Date(now.getTime() - 86_400_000)))))
    .orderBy(asc(schema.domainNames.syncedAt))
    .limit(limit);
  let done = 0;
  for (const { id } of due) await syncDomain(id).then(() => done++, () => {});
  return done;
}

export async function setDomainNameservers(domainId: string, input: string[], actorId: string | null = null) {
  const nameservers = cleanNameservers(input);
  const { d, mod, creds } = await manageable(domainId);
  await wrap(() => mod.setNameservers(creds, d.name, nameservers, http));
  await (await getDb()).update(schema.domainNames).set({ nameservers }).where(eq(schema.domainNames.id, d.id));
  await audit(actorId, "domain.nameservers", "domain", d.id, { nameservers });
}

export async function setDomainLock(domainId: string, locked: boolean, actorId: string | null = null) {
  const { d, mod, creds } = await manageable(domainId);
  await wrap(() => mod.setLock(creds, d.name, locked, http));
  await (await getDb()).update(schema.domainNames).set({ locked }).where(eq(schema.domainNames.id, d.id));
  await audit(actorId, locked ? "domain.locked" : "domain.unlocked", "domain", d.id);
}

/** Hides or shows the registrant in public WHOIS. Registries that already hide personal data (.it, most of the EU) need nothing. */
export async function setDomainPrivacy(domainId: string, enabled: boolean, actorId: string | null = null) {
  const { d, mod, creds } = await manageable(domainId);
  await wrap(() => mod.setPrivacy(creds, d.name, enabled, http));
  await (await getDb()).update(schema.domainNames).set({ privacy: enabled }).where(eq(schema.domainNames.id, d.id));
  await audit(actorId, enabled ? "domain.privacy_on" : "domain.privacy_off", "domain", d.id);
}

/** New registrant and contact details, sent to the registry and kept as the domain's snapshot. */
export async function updateDomainContact(domainId: string, input: Record<string, unknown>, actorId: string | null = null) {
  const { d, mod, creds } = await manageable(domainId);
  const contact = cleanContact(input, d.name);
  await wrap(() => mod.updateContact(creds, d.name, contact, http));
  await (await getDb()).update(schema.domainNames).set({ contact: contact as unknown as Record<string, string> }).where(eq(schema.domainNames.id, d.id));
  await audit(actorId, "domain.contact_changed", "domain", d.id);
}

/** The code that lets the owner move the domain elsewhere. Audited, never stored. */
export async function domainAuthCode(domainId: string, actorId: string | null = null): Promise<string> {
  const { d, mod, creds } = await manageable(domainId);
  if (d.locked) throw new DomainError("Unlock the domain first");
  const code = await wrap(() => mod.authCode(creds, d.name, http));
  await audit(actorId, "domain.authcode_revealed", "domain", d.id);
  return code;
}
