import "server-only";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { BILLING_CYCLES, type BillingCycle, type DomainStatus, type ServiceStatus } from "@/db/schema";
import { getRegistrar } from "@/modules/registrars";
import { audit } from "./audit";
import { hashPassword } from "./crypto";
import { domainProduct } from "./domains";
import { DOMAIN_RE, slugify } from "./format";
import { createCompany } from "./roles";

/**
 * Moving in from another billing system. The source is first turned into a
 * neutral bundle (customers, services, domains); this file checks it and
 * writes it. Nothing is provisioned, charged or emailed: imported services
 * are records that start renewing here from their next due date. Running
 * the same import again adds nothing, so a partial run can simply be repeated.
 */

export type ImportClient = { ref: string; email: string; firstName?: string; lastName?: string; company?: string; vatId?: string; phone?: string; address?: string; city?: string; zip?: string; state?: string; country?: string; active?: boolean };
export type ImportService = { ref: string; clientRef: string; product: string; domain?: string; cycle: string; amount: number; nextDueDate?: string; createdAt?: string; status: string };
export type ImportDomain = { ref: string; clientRef: string; name: string; registrar?: string; amount: number; expiresAt?: string; nextDueDate?: string; status: string };
export type ImportBundle = { source: string; clients: ImportClient[]; services: ImportService[]; domains: ImportDomain[] };

export type ImportReport = {
  clients: { created: number; existing: number };
  services: { created: number; existing: number };
  domains: { created: number; existing: number };
  products: string[];
  skipped: string[];
  warnings: string[];
};

const CYCLES: Record<string, BillingCycle> = { monthly: "monthly", quarterly: "quarterly", "semi-annually": "semiannually", semiannually: "semiannually", annually: "annually", yearly: "annually", biennially: "biennially", "one time": "onetime", onetime: "onetime", "free account": "onetime", free: "onetime" };
const SERVICE_STATUS: Record<string, ServiceStatus> = { active: "active", suspended: "suspended", pending: "pending" };
const DOMAIN_STATUS: Record<string, DomainStatus> = { active: "active", "pending transfer": "transferring", expired: "expired", grace: "expired", redemption: "expired" };

const date = (raw: string | undefined) => {
  // Other systems write "no date" as zeros.
  const d = raw && !/^0000/.test(raw) ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const text = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const importRef = sql<string>`${schema.services.moduleData}->>'importRef'`;

/** `apply: false` only reports what would happen. */
export async function runImport(bundle: ImportBundle, apply: boolean, actorId: string | null = null): Promise<ImportReport> {
  const db = await getDb();
  const report: ImportReport = { clients: { created: 0, existing: 0 }, services: { created: 0, existing: 0 }, domains: { created: 0, existing: 0 }, products: [], skipped: [], warnings: [] };
  const source = slugify(bundle.source).slice(0, 20) || "import";

  // ── Customers: matched by email, each with a company of their own.
  const owner = new Map<string, { userId: string; companyId: string } | null>();
  for (const c of bundle.clients.slice(0, 50_000)) {
    const email = text(c.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      report.skipped.push(`customer ${c.ref}: no valid email`);
      continue;
    }
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(sql`lower(${schema.users.email})`, email));
    if (existing) {
      report.clients.existing++;
      const [member] = await db.select({ companyId: schema.companyMembers.companyId }).from(schema.companyMembers).where(eq(schema.companyMembers.userId, existing.id)).limit(1);
      owner.set(c.ref, { userId: existing.id, companyId: member?.companyId ?? (apply ? await createCompany({ id: existing.id, email }, text(c.company) || `${text(c.firstName)} ${text(c.lastName)}`.trim()) : "") });
      continue;
    }
    report.clients.created++;
    if (!apply) {
      owner.set(c.ref, { userId: "", companyId: "" });
      continue;
    }
    // Passwords cannot be carried over: a random one nobody knows, replaced through "Forgot your password?".
    const [user] = await db
      .insert(schema.users)
      .values({ email, passwordHash: await hashPassword(randomBytes(32).toString("base64url")), firstName: text(c.firstName, 100), lastName: text(c.lastName, 100), company: text(c.company), vatId: text(c.vatId, 40), phone: text(c.phone, 40), address: text(c.address), city: text(c.city, 100), zip: text(c.zip, 20), state: text(c.state, 100), country: text(c.country, 2).toUpperCase(), status: c.active === false ? "suspended" : "active" })
      .returning({ id: schema.users.id });
    const companyId = await createCompany({ id: user.id, email }, text(c.company) || `${text(c.firstName)} ${text(c.lastName)}`.trim(), { orgType: c.company ? "company" : "individual", billingName: text(c.company), vatId: text(c.vatId, 40), address1: text(c.address), city: text(c.city, 100), zip: text(c.zip, 20), state: text(c.state, 100), country: text(c.country, 2).toUpperCase() });
    owner.set(c.ref, { userId: user.id, companyId });
  }

  // ── Products: by name; unknown ones become hidden "manual" products, so nothing is provisioned by surprise.
  const products = new Map((await db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products)).map((p) => [p.name.trim().toLowerCase(), p.id]));
  let groupId = "";
  const productFor = async (name: string, cycle: BillingCycle, amount: number) => {
    const key = name.trim().toLowerCase();
    if (products.has(key)) return products.get(key)!;
    report.products.push(name);
    if (!apply) return products.set(key, "").get(key)!;
    if (!groupId) {
      const [g] = await db.insert(schema.productGroups).values({ slug: "imported", name: "Imported", hidden: true }).onConflictDoNothing().returning({ id: schema.productGroups.id });
      groupId = g?.id ?? (await db.select({ id: schema.productGroups.id }).from(schema.productGroups).where(eq(schema.productGroups.slug, "imported")))[0].id;
    }
    const [p] = await db.insert(schema.products).values({ groupId, name: name.slice(0, 120), slug: `imported-${slugify(name).slice(0, 60)}-${randomBytes(2).toString("hex")}`, module: "manual", hidden: true, requiresDomain: false, pricing: { [cycle]: amount } }).returning({ id: schema.products.id });
    return products.set(key, p.id).get(key)!;
  };

  // ── Services.
  for (const s of bundle.services.slice(0, 200_000)) {
    const who = owner.get(s.clientRef);
    const status = SERVICE_STATUS[text(s.status).toLowerCase()];
    const cycle = CYCLES[text(s.cycle).toLowerCase()];
    if (!status) continue; // cancelled, terminated, fraud: history, not something to bill
    if (!who) { report.skipped.push(`service ${s.ref}: its customer was not imported`); continue; }
    if (!cycle || !BILLING_CYCLES.includes(cycle)) { report.skipped.push(`service ${s.ref}: billing cycle “${text(s.cycle, 40)}” is not supported`); continue; }
    const amount = Math.round(Number(s.amount));
    if (!Number.isFinite(amount) || amount < 0) { report.skipped.push(`service ${s.ref}: invalid amount`); continue; }
    const ref = `${source}:service:${text(s.ref, 60)}`;
    const [dup] = await db.select({ id: schema.services.id }).from(schema.services).where(eq(importRef, ref));
    if (dup) { report.services.existing++; continue; }
    const productId = await productFor(text(s.product, 120) || "Imported service", cycle, amount);
    const due = date(s.nextDueDate);
    if (cycle !== "onetime" && !due) report.warnings.push(`service ${s.ref}: no next due date, it will not renew by itself`);
    else if (due && due < new Date()) report.warnings.push(`service ${s.ref}: its due date has already passed — it is invoiced at the next daily run`);
    report.services.created++;
    if (!apply) continue;
    await db.insert(schema.services).values({ clientId: who.userId, companyId: who.companyId, productId, status, domain: text(s.domain, 253).toLowerCase(), billingCycle: cycle, amount, nextDueDate: cycle === "onetime" ? null : due, createdAt: date(s.createdAt) ?? new Date(), moduleData: { importRef: ref } });
  }

  // ── Domains: a service that bills the renewal, plus the domain itself.
  const domainProductId = apply && bundle.domains.length ? await domainProduct() : "";
  for (const d of bundle.domains.slice(0, 200_000)) {
    const who = owner.get(d.clientRef);
    const status = DOMAIN_STATUS[text(d.status).toLowerCase()];
    const name = text(d.name, 253).toLowerCase();
    if (!status) continue;
    if (!who) { report.skipped.push(`domain ${name}: its customer was not imported`); continue; }
    if (!DOMAIN_RE.test(name)) { report.skipped.push(`domain ${d.ref}: “${name.slice(0, 60)}” is not a domain name`); continue; }
    const [dup] = await db.select({ id: schema.domainNames.id }).from(schema.domainNames).where(eq(schema.domainNames.name, name));
    if (dup) { report.domains.existing++; continue; }
    const registrar = text(d.registrar, 40).toLowerCase();
    if (!getRegistrar(registrar)) report.warnings.push(`domain ${name}: registrar “${registrar || "none"}” is not connected here — it is billed, but must be renewed by hand until it is moved to a connected registrar`);
    const amount = Math.max(0, Math.round(Number(d.amount)) || 0);
    const expiresAt = date(d.expiresAt);
    report.domains.created++;
    if (!apply) continue;
    const [service] = await db.insert(schema.services).values({ clientId: who.userId, companyId: who.companyId, productId: domainProductId, status: "active", domain: name, billingCycle: "annually", amount, nextDueDate: date(d.nextDueDate) ?? expiresAt, moduleData: { importRef: `${source}:domain:${text(d.ref, 60)}` } }).returning({ id: schema.services.id });
    await db.insert(schema.domainNames).values({ name, clientId: who.userId, companyId: who.companyId, serviceId: service.id, registrar: registrar || "manual", status, expiresAt, nameservers: [], contact: {} });
  }

  report.skipped = report.skipped.slice(0, 200);
  report.warnings = report.warnings.slice(0, 200);
  if (apply) await audit(actorId, "import.applied", "import", source, { clients: report.clients.created, services: report.services.created, domains: report.domains.created });
  return report;
}
