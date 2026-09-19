"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { sanitizeBlocks } from "@/cms/blocks";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { BILLING_CYCLES, type Pricing } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAdmin, requireArea, startImpersonation } from "@/lib/auth";
import { activateService, adjustCredit, BillingError, issueCreditNote, recordPayment, runAutomation, suspendService, terminateService, unsuspendService } from "@/lib/billing";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { parseMoney, slugify } from "@/lib/format";
import { platformHomeBlocks, seedFooterColumns, seedPlatformPlans } from "@/lib/install";
import { templateDef } from "@/lib/mail/templates";
import { notify, resendInvoice, sendTestMail } from "@/lib/notify";
import { settingsSchemas, updateSettings, getSettings } from "@/lib/settings";
import { getProvisioningModule, provisioningModules } from "@/modules/provisioning";

const uuid = z.string().uuid();
const text = (max = 200) => z.string().trim().max(max).default("");
const fields = (form: FormData) => Object.fromEntries(form);
const firstIssue = (err: z.ZodError) => `${err.issues[0].path.join(".")}: ${err.issues[0].message}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** Postgres foreign-key violation → the row is still referenced. */
const isFkViolation = (err: unknown) => /foreign key|23503/i.test(`${message(err)} ${(err as { code?: string })?.code ?? ""}`);

// ─── Clients ─────────────────────────────────────────────────────────────────

export async function saveClient(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("clients");
  const parsed = z
    .object({
      id: uuid,
      email: z.string().trim().toLowerCase().email(),
      status: z.enum(["active", "suspended", "closed"]),
      firstName: text(100),
      lastName: text(100),
      company: text(150),
      vatId: text(50),
      phone: text(50),
      address: text(200),
      city: text(100),
      zip: text(20),
      state: text(100),
      country: text(100),
      adminNotes: text(5000),
    })
    .safeParse(fields(form));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const { id, ...data } = parsed.data;
  const db = await getDb();
  // Staff edit clients only: changing a colleague's email would be a way to take over their account.
  const [target] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, id));
  if (!target || (target.role !== "client" && staff.role !== "admin")) return { error: "Only an administrator can edit staff accounts" };
  try {
    await db.update(schema.users).set(data).where(eq(schema.users.id, id));
  } catch {
    return { error: "An account with this email already exists" };
  }
  if (data.status !== "active") await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
  await audit(staff.id, "client.updated", "user", id);
  revalidatePath(`/admin/clients/${id}`);
  return { ok: "Saved" };
}

// ─── Services ────────────────────────────────────────────────────────────────

export async function serviceCommand(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  const parsed = z
    .object({ id: uuid, command: z.enum(["activate", "suspend", "unsuspend", "terminate"]), reason: text(200) })
    .safeParse(fields(form));
  if (!parsed.success) return { error: "Invalid request" };
  const { id, command, reason } = parsed.data;

  try {
    if (command === "activate") await activateService(id, staff.id);
    else if (command === "suspend") await suspendService(id, reason || "Suspended by staff", staff.id);
    else if (command === "unsuspend") await unsuspendService(id, staff.id);
    else await terminateService(id, staff.id);
  } catch (err) {
    return { error: message(err) };
  } finally {
    revalidatePath(`/admin/services/${id}`);
  }
  return { ok: "Done" };
}

export async function saveService(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  const parsed = z
    .object({
      id: uuid,
      domain: text(253),
      username: text(64),
      serverId: z.union([uuid, z.literal("")]),
      billingCycle: z.enum(BILLING_CYCLES),
      amount: z.string(),
      nextDueDate: z.union([z.iso.date(), z.literal("")]),
    })
    .safeParse(fields(form));
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const amount = parseMoney(parsed.data.amount);
  if (amount === null) return { error: "Invalid amount" };

  const { id, serverId, nextDueDate, ...rest } = parsed.data;
  const db = await getDb();
  await db
    .update(schema.services)
    .set({ ...rest, amount, serverId: serverId || null, nextDueDate: nextDueDate ? new Date(`${nextDueDate}T00:00:00Z`) : null })
    .where(eq(schema.services.id, id));
  await audit(staff.id, "service.updated", "service", id);
  revalidatePath(`/admin/services/${id}`);
  return { ok: "Saved" };
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export async function addPayment(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  const parsed = z.object({ invoiceId: uuid, amount: z.string(), reference: text(100) }).safeParse(fields(form));
  if (!parsed.success) return { error: "Invalid request" };
  const amount = parseMoney(parsed.data.amount);
  if (!amount) return { error: "Invalid amount" };

  try {
    await recordPayment({ invoiceId: parsed.data.invoiceId, gateway: "manual", externalId: parsed.data.reference, amount, actorId: staff.id });
  } catch (err) {
    return { error: message(err) };
  }
  revalidatePath(`/admin/invoices/${parsed.data.invoiceId}`);
  return { ok: "Payment recorded" };
}

export async function resendInvoiceEmail(_: ActionState, form: FormData): Promise<ActionState> {
  await requireArea("billing");
  const result = await resendInvoice(uuid.parse(form.get("invoiceId")));
  return result.ok ? { ok: "Email sent" } : { error: result.error ?? "Email could not be sent" };
}

export async function cancelInvoice(form: FormData) {
  const staff = await requireArea("billing");
  const id = uuid.parse(form.get("invoiceId"));
  const db = await getDb();
  await db.update(schema.invoices).set({ status: "cancelled" }).where(sql`${schema.invoices.id} = ${id} and ${schema.invoices.status} = 'unpaid'`);
  await audit(staff.id, "invoice.cancelled", "invoice", id);
  revalidatePath(`/admin/invoices/${id}`);
}

export async function addCredit(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  const raw = String(form.get("amount") ?? "").trim();
  const cents = parseMoney(raw.replace(/^-/, ""));
  if (cents === null || cents === 0) return { error: "Enter an amount such as 25.00" };
  try {
    await adjustCredit(uuid.parse(form.get("companyId")), raw.startsWith("-") ? -cents : cents, String(form.get("reason") ?? "").trim() || "Manual adjustment", staff.id);
  } catch (err) {
    if (err instanceof BillingError) return { error: err.message };
    throw err;
  }
  revalidatePath("/admin/clients", "layout");
  return { ok: "Saved" };
}

export async function sendInvoiceToSdi(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  const id = uuid.parse(form.get("invoiceId"));
  const { sendToSdi, refreshSdiStatus, SdiSendError } = await import("@/lib/sdi");
  try {
    if (form.get("refresh")) await refreshSdiStatus(id);
    else await sendToSdi(id, staff.id);
  } catch (err) {
    revalidatePath(`/admin/invoices/${id}`);
    return { error: err instanceof SdiSendError || err instanceof Error ? err.message.slice(0, 300) : "The intermediary could not be reached" };
  }
  revalidatePath(`/admin/invoices/${id}`);
  return { ok: form.get("refresh") ? "Updated" : "Handed to the intermediary. The SDI outcome arrives within minutes or a few days." };
}

export async function signInAsClient(form: FormData) {
  const staff = await requireArea("clients");
  const clientId = uuid.parse(form.get("clientId"));
  if (!(await startImpersonation(staff, clientId))) redirect(`/admin/clients/${clientId}`);
  await audit(staff.id, "client.impersonated", "user", clientId);
  redirect("/client");
}

export async function creditInvoice(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  let creditId: string;
  try {
    creditId = await issueCreditNote(uuid.parse(form.get("invoiceId")), String(form.get("reason") ?? "").trim(), staff.id);
  } catch (err) {
    if (err instanceof BillingError) return { error: err.message };
    throw err;
  }
  redirect(`/admin/invoices/${creditId}`);
}

// ─── Tickets ─────────────────────────────────────────────────────────────────

export async function staffReply(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("support");
  const parsed = z.object({ ticketId: uuid, body: z.string().trim().min(2).max(20_000) }).safeParse(fields(form));
  if (!parsed.success) return { error: "Message is empty" };
  const db = await getDb();
  await db.insert(schema.ticketMessages).values({ ticketId: parsed.data.ticketId, authorId: staff.id, body: parsed.data.body });
  await db.update(schema.tickets).set({ status: "answered", lastReplyAt: new Date() }).where(eq(schema.tickets.id, parsed.data.ticketId));
  notify.ticketStaffReply(parsed.data.ticketId, parsed.data.body);
  revalidatePath(`/admin/tickets/${parsed.data.ticketId}`);
}

export async function setTicketStatus(form: FormData) {
  await requireArea("support");
  const parsed = z.object({ ticketId: uuid, status: z.enum(["open", "closed"]) }).parse(fields(form));
  const db = await getDb();
  await db.update(schema.tickets).set({ status: parsed.status }).where(eq(schema.tickets.id, parsed.ticketId));
  revalidatePath(`/admin/tickets/${parsed.ticketId}`);
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export async function saveGroup(_: ActionState, form: FormData): Promise<ActionState> {
  await requireArea("billing");
  const parsed = z
    .object({ id: z.union([uuid, z.literal("")]).default(""), name: z.string().trim().min(1).max(100), slug: text(80), description: text(500), position: z.coerce.number().int().default(0) })
    .safeParse(fields(form));
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, ...data } = parsed.data;
  data.slug = slugify(data.slug || data.name);
  const db = await getDb();
  try {
    if (id) await db.update(schema.productGroups).set(data).where(eq(schema.productGroups.id, id));
    else await db.insert(schema.productGroups).values(data);
  } catch {
    return { error: "Slug already in use" };
  }
  revalidatePath("/admin/products");
  return { ok: "Saved" };
}

export async function deleteGroup(form: FormData) {
  await requireArea("billing");
  const db = await getDb();
  // FK is RESTRICT: a group that still has products is left untouched.
  await db.delete(schema.productGroups).where(eq(schema.productGroups.id, uuid.parse(form.get("id")))).catch(() => {});
  revalidatePath("/admin/products");
}

export async function saveProduct(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  const parsed = z
    .object({
      id: z.union([uuid, z.literal("")]).default(""),
      groupId: uuid,
      name: z.string().trim().min(1).max(100),
      slug: text(80),
      tagline: text(200),
      description: text(5000),
      features: text(5000),
      module: z.string().refine((m) => provisioningModules.some((x) => x.id === m), "Unknown module"),
      serverId: z.union([uuid, z.literal("")]),
      position: z.coerce.number().int().default(0),
    })
    .safeParse(fields(form));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const pricing: Pricing = {};
  for (const key of [...BILLING_CYCLES, "setup"] as const) {
    const raw = String(form.get(`price_${key}`) ?? "").trim();
    if (!raw) continue;
    const cents = parseMoney(raw);
    if (cents === null) return { error: `Invalid price: ${raw}` };
    pricing[key] = cents;
  }

  const mod = getProvisioningModule(parsed.data.module);
  const moduleConfig = Object.fromEntries(
    mod.productFields.map((f) => [f.name, String(form.get(`mc_${mod.id}_${f.name}`) ?? "").trim()]),
  );

  const { id, features, serverId, ...rest } = parsed.data;
  const data = {
    ...rest,
    slug: slugify(rest.slug || rest.name),
    features: features.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 30),
    serverId: serverId || null,
    pricing,
    moduleConfig,
    requiresDomain: form.has("requiresDomain"),
    featured: form.has("featured"),
    hidden: form.has("hidden"),
  };

  const db = await getDb();
  let savedId = id;
  try {
    if (id) await db.update(schema.products).set(data).where(eq(schema.products.id, id));
    else [{ id: savedId }] = await db.insert(schema.products).values(data).returning({ id: schema.products.id });
  } catch {
    return { error: "Slug already in use" };
  }
  await audit(staff.id, id ? "product.updated" : "product.created", "product", savedId);
  revalidatePath("/admin/products");
  if (!id) redirect(`/admin/products/${savedId}`);
  return { ok: "Saved" };
}

export async function deleteProduct(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  const id = uuid.parse(form.get("id"));
  const db = await getDb();
  try {
    await db.delete(schema.products).where(eq(schema.products.id, id));
  } catch (err) {
    if (isFkViolation(err)) return { error: "This product has services. Hide it instead of deleting it." };
    throw err;
  }
  await audit(staff.id, "product.deleted", "product", id);
  redirect("/admin/products");
}

// ─── Servers (admin only: they hold credentials) ─────────────────────────────

export async function saveServer(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = z
    .object({
      id: z.union([uuid, z.literal("")]).default(""),
      name: z.string().trim().min(1).max(100),
      module: z.string().refine((m) => provisioningModules.some((x) => x.id === m && x.requiresServer), "Unknown module"),
      hostname: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+$/, "Invalid hostname").max(253),
      maxAccounts: z.coerce.number().int().min(0).default(0),
    })
    .safeParse(fields(form));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const { id, ...rest } = parsed.data;
  const db = await getDb();
  const existing = id ? await db.query.servers.findFirst({ where: eq(schema.servers.id, id) }) : undefined;
  const previous = decryptJson<Record<string, string>>(existing?.credentials ?? "", {});

  const mod = getProvisioningModule(rest.module);
  const credentials: Record<string, string> = {};
  for (const f of mod.serverFields) {
    const value = String(form.get(`cred_${f.name}`) ?? "").trim();
    // Secrets are never sent back to the browser: blank means "keep current".
    credentials[f.name] = value || (f.type === "password" ? (previous[f.name] ?? "") : "");
    if (f.required && !credentials[f.name]) return { error: `${f.label} is required` };
  }

  const data = { ...rest, credentials: encryptJson(credentials), active: form.has("active") };
  let savedId = id;
  if (id) await db.update(schema.servers).set(data).where(eq(schema.servers.id, id));
  else [{ id: savedId }] = await db.insert(schema.servers).values(data).returning({ id: schema.servers.id });

  await audit(admin.id, id ? "server.updated" : "server.created", "server", savedId);
  revalidatePath("/admin/servers");
  if (!id) redirect(`/admin/servers/${savedId}`);
  return { ok: "Saved" };
}

export async function testServer(_: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  const db = await getDb();
  const server = await db.query.servers.findFirst({ where: eq(schema.servers.id, uuid.parse(form.get("id"))) });
  if (!server) return { error: "Server not found" };
  const mod = getProvisioningModule(server.module);
  if (!mod.testConnection) return { ok: "This module has no connection test" };
  const result = await mod.testConnection({
    id: server.id,
    name: server.name,
    hostname: server.hostname,
    credentials: decryptJson<Record<string, string>>(server.credentials, {}),
  });
  return result.ok ? { ok: result.message } : { error: result.message };
}

export async function deleteServer(form: FormData) {
  const admin = await requireAdmin();
  const id = uuid.parse(form.get("id"));
  const db = await getDb();
  await db.delete(schema.servers).where(eq(schema.servers.id, id));
  await audit(admin.id, "server.deleted", "server", id);
  redirect("/admin/servers");
}

// ─── Site builder ────────────────────────────────────────────────────────────

export async function savePage(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("content");
  const parsed = z
    .object({
      id: z.union([uuid, z.literal("")]).default(""),
      title: z.string().trim().min(1).max(200),
      slug: z.string().trim().toLowerCase().max(200).regex(/^([a-z0-9-]+(\/[a-z0-9-]+)*)?$/, "Use lowercase letters, numbers, dashes and slashes"),
      status: z.enum(["draft", "published"]),
      seoTitle: text(200),
      seoDescription: text(500),
      excerpt: text(400),
      blocks: z.string().max(500_000),
    })
    .safeParse(fields(form));
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  if (/^(admin|client|api|login|register|install|order|forgot-password|reset-password|invite|agent)(\/|$)/.test(parsed.data.slug)) return { error: "This slug is reserved" };

  let blocks: unknown;
  try {
    blocks = JSON.parse(parsed.data.blocks);
  } catch {
    return { error: "Invalid page content" };
  }

  const { id, ...rest } = parsed.data;
  const data = { ...rest, blocks: sanitizeBlocks(blocks) };
  const db = await getDb();
  let savedId = id;
  try {
    if (id) await db.update(schema.pages).set(data).where(eq(schema.pages.id, id));
    else [{ id: savedId }] = await db.insert(schema.pages).values(data).returning({ id: schema.pages.id });
  } catch {
    return { error: "Slug already in use" };
  }
  await audit(staff.id, id ? "page.updated" : "page.created", "page", savedId);
  revalidatePath("/", "layout");
  if (!id) redirect(`/admin/pages/${savedId}`);
  return { ok: "Saved" };
}

/** Replaces the home page and footer menu with the platform template (plans are created if missing). */
export async function installPlatformHome() {
  const staff = await requireArea("content");
  await seedPlatformPlans();
  const blocks = await platformHomeBlocks((await getSettings("general")).siteName);
  const db = await getDb();
  await db
    .insert(schema.pages)
    .values({ slug: "", title: "Home", status: "published", blocks })
    .onConflictDoUpdate({ target: schema.pages.slug, set: { blocks, status: "published", updatedAt: new Date() } });
  await seedFooterColumns();
  await audit(staff.id, "page.template_installed", "page", "home");
  revalidatePath("/", "layout");
}

export async function deletePage(form: FormData) {
  const staff = await requireArea("content");
  const id = uuid.parse(form.get("id"));
  const db = await getDb();
  await db.delete(schema.pages).where(eq(schema.pages.id, id));
  await audit(staff.id, "page.deleted", "page", id);
  redirect("/admin/pages");
}

export async function saveMenuItem(_: ActionState, form: FormData): Promise<ActionState> {
  await requireArea("content");
  const parsed = z
    .object({
      id: z.union([uuid, z.literal("")]).default(""),
      location: z.enum(["header", "footer"]),
      label: z.string().trim().min(1).max(60),
      href: z.string().trim().max(500).regex(/^(\/|#|https?:\/\/|mailto:|tel:)/i, "Link must start with /, #, http(s)://, mailto: or tel:"),
      columnTitle: text(40),
      position: z.coerce.number().int().default(0),
    })
    .safeParse(fields(form));
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { id, ...data } = parsed.data;
  const db = await getDb();
  if (id) await db.update(schema.menuItems).set(data).where(eq(schema.menuItems.id, id));
  else await db.insert(schema.menuItems).values(data);
  revalidatePath("/", "layout");
  return { ok: "Saved" };
}

export async function deleteMenuItem(form: FormData) {
  await requireArea("content");
  const db = await getDb();
  await db.delete(schema.menuItems).where(eq(schema.menuItems.id, uuid.parse(form.get("id"))));
  revalidatePath("/", "layout");
}

// ─── Settings (admin only) ───────────────────────────────────────────────────

const checkbox = (form: FormData, name: string) => form.has(name);

export async function saveGeneral(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = settingsSchemas.general.partial().safeParse({ ...fields(form), allowRegistration: checkbox(form, "allowRegistration") });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  delete parsed.data.installed;
  if (parsed.data.siteUrl && !/^https?:\/\/[^\s/]+$/.test((parsed.data.siteUrl = parsed.data.siteUrl.replace(/\/+$/, "")))) {
    return { error: "Site URL must look like https://example.com" };
  }
  await updateSettings("general", parsed.data);
  await audit(admin.id, "settings.updated", "settings", "general");
  revalidatePath("/", "layout");
  return { ok: "Saved" };
}

export async function saveTheme(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = settingsSchemas.theme.partial().safeParse(fields(form));
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  if (parsed.data.logoUrl && !/^(\/|https:\/\/)/.test(parsed.data.logoUrl)) return { error: "Logo URL must start with / or https://" };
  await updateSettings("theme", parsed.data);
  await audit(admin.id, "settings.updated", "settings", "theme");
  revalidatePath("/", "layout");
  return { ok: "Saved" };
}

export async function saveBilling(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const f = fields(form);
  const percent = Number(String(f.taxPercent ?? "0").replace(",", "."));
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return { error: "Invalid tax rate" };
  const parsed = settingsSchemas.billing.partial().safeParse({
    currency: String(f.currency ?? "").toUpperCase(),
    taxRate: Math.round(percent * 100),
    taxName: f.taxName,
    invoicePrefix: f.invoicePrefix,
    bankTransferInstructions: f.bankTransferInstructions,
    invoiceDaysBeforeDue: Number(f.invoiceDaysBeforeDue),
    suspendDaysAfterDue: Number(f.suspendDaysAfterDue),
    terminateDaysAfterDue: Number(f.terminateDaysAfterDue),
    referralPercent: Number(f.referralPercent) || 0,
    referralMonths: Number(f.referralMonths) || 12,
    overdueReminderDays: [...new Set(String(f.overdueReminderDays ?? "").split(/[\s,;]+/).filter(Boolean).map(Number))].sort((a, b) => a - b),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  await updateSettings("billing", parsed.data);
  await audit(admin.id, "settings.updated", "settings", "billing");
  return { ok: "Saved" };
}

export async function saveGateways(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const current = await getSettings("gateways");
  const secret = (name: string, previous: string) => String(form.get(name) ?? "").trim() || previous;
  await updateSettings("gateways", {
    bankTransfer: { enabled: checkbox(form, "bankTransferEnabled") },
    stripe: {
      enabled: checkbox(form, "stripeEnabled"),
      secretKey: secret("stripeSecretKey", current.stripe.secretKey),
      webhookSecret: secret("stripeWebhookSecret", current.stripe.webhookSecret),
      saveCards: checkbox(form, "stripeSaveCards"),
    },
    paypal: {
      enabled: checkbox(form, "paypalEnabled"),
      clientId: String(form.get("paypalClientId") ?? "").trim().slice(0, 200),
      secret: secret("paypalSecret", current.paypal.secret),
      webhookId: String(form.get("paypalWebhookId") ?? "").trim().slice(0, 100),
      sandbox: checkbox(form, "paypalSandbox"),
    },
  });
  await audit(admin.id, "settings.updated", "settings", "gateways");
  return { ok: "Saved" };
}

export async function saveMail(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const current = await getSettings("mail");
  const f = fields(form);
  const optionalEmail = z.union([z.string().trim().email(), z.literal("")]);
  const parsed = z
    .object({
      host: z.string().trim().max(253),
      port: z.coerce.number().int().min(1).max(65535),
      security: z.enum(["starttls", "ssl", "none"]),
      username: text(200),
      fromName: text(100),
      fromEmail: optionalEmail,
      staffEmail: optionalEmail,
    })
    .safeParse(f);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const enabled = checkbox(form, "enabled");
  if (enabled && (!parsed.data.host || !parsed.data.fromEmail)) return { error: "SMTP host and sender address are required" };

  await updateSettings("mail", { ...parsed.data, enabled, password: String(f.password ?? "") || current.password });
  await audit(admin.id, "settings.updated", "settings", "mail");
  return { ok: "Saved" };
}

export async function saveEmailTemplate(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = z
    .object({
      id: z.string().refine((id) => !!templateDef(id), "Unknown template"),
      subject: text(200),
      heading: text(200),
      body: z.string().max(5000).default(""),
    })
    .safeParse(fields(form));
  if (!parsed.success) return { error: firstIssue(parsed.error) };

  const { id, ...wording } = parsed.data;
  const values = { ...wording, body: wording.body.replace(/\r\n?/g, "\n").trim(), enabled: checkbox(form, "enabled") };
  const db = await getDb();
  await db
    .insert(schema.emailTemplates)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: schema.emailTemplates.id, set: { ...values, updatedAt: new Date() } });
  await audit(admin.id, "mail.template.updated", "email_template", id, { enabled: values.enabled });
  revalidatePath("/admin/settings/mail/templates", "layout");
  return { ok: "Saved" };
}

export async function resetEmailTemplate(form: FormData) {
  const admin = await requireAdmin();
  const id = String(form.get("id") ?? "");
  const db = await getDb();
  await db.delete(schema.emailTemplates).where(eq(schema.emailTemplates.id, id));
  await audit(admin.id, "mail.template.reset", "email_template", id);
  revalidatePath("/admin/settings/mail/templates", "layout");
}

export async function sendTestEmail(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const to = z.string().trim().email().safeParse(form.get("to"));
  if (!to.success) return { error: "Enter a valid email address" };
  const result = await sendTestMail(to.data);
  await audit(admin.id, "mail.test", "settings", "mail", { to: to.data, ok: result.ok });
  revalidatePath("/admin/settings/mail");
  return result.ok ? { ok: "Test email sent" } : { error: result.error ?? "Email could not be sent" };
}

// ─── Automation ──────────────────────────────────────────────────────────────

export async function runAutomationNow(): Promise<ActionState> {
  await requireArea("billing");
  const r = await runAutomation();
  revalidatePath("/admin/automation");
  const summary = `Invoices: ${r.invoiced} · Reminders: ${r.reminded} · Suspended: ${r.suspended} · Terminated: ${r.terminated}`;
  return r.errors.length ? { error: `${summary}\n${r.errors.join("\n")}` } : { ok: summary };
}
