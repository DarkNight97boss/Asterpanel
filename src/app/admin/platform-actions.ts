"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { randomToken, sha256 } from "@/lib/crypto";
import { baseUrl } from "@/lib/url";
import { getSettings, updateSettings } from "@/lib/settings";
import { getSdiProvider } from "@/modules/sdi";
import { CloudNodeError, createCloudNode, destroyCloudServer, testCloudProvider } from "@/lib/cloud";
import { getCloudProvider } from "@/modules/cloud";
import { PlatformError, signingKeys, syncDns, testOffsite } from "@/platform/engine";

const nodeFields = z.object({
  name: z.string().trim().min(1).max(60),
  region: z.string().trim().max(40).default(""),
  baseDomain: z.string().trim().toLowerCase().regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/, "Enter a domain like n1.example.com").or(z.literal("")),
  publicIp: z.string().trim().max(45).default(""),
  maxWorkloads: z.coerce.number().int().min(0).default(0),
});

/** The credentials are shown exactly once: only a hash of the token is stored. */
async function installInstructions(nodeId: string, token: string) {
  const [origin, keys] = await Promise.all([baseUrl(), signingKeys()]);
  return [
    "Run this on the server (Docker, git and Node.js 20+ required). The token is shown only once:",
    "",
    `curl -fsSL ${origin}/agent/install.sh | sudo ASTER_TOKEN='${nodeId}.${token}' ASTER_PUBLIC_KEY='${keys.publicKey}' ASTER_ACME_EMAIL='you@example.com' bash`,
  ].join("\n");
}

export async function createNode(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = nodeFields.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const token = randomToken(32);
  const db = await getDb();
  const [node] = await db.insert(schema.nodes).values({ ...parsed.data, tokenHash: sha256(token) }).returning({ id: schema.nodes.id });
  await audit(admin.id, "node.created", "node", node.id);
  revalidatePath("/admin/nodes");
  return { ok: await installInstructions(node.id, token) };
}

export async function saveNode(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = z.string().uuid().parse(form.get("id"));
  const parsed = nodeFields.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const db = await getDb();
  await db
    .update(schema.nodes)
    .set({ ...parsed.data, status: form.has("disabled") ? "disabled" : "pending" })
    .where(eq(schema.nodes.id, id));
  await audit(admin.id, "node.updated", "node", id);
  revalidatePath(`/admin/nodes/${id}`);
  return { ok: "Saved" };
}

export async function rotateNodeToken(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = z.string().uuid().parse(form.get("id"));
  const token = randomToken(32);
  const db = await getDb();
  await db.update(schema.nodes).set({ tokenHash: sha256(token) }).where(eq(schema.nodes.id, id));
  await audit(admin.id, "node.token_rotated", "node", id);
  return { ok: await installInstructions(id, token) };
}

export async function deleteNode(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = z.string().uuid().parse(form.get("id"));
  const db = await getDb();
  const [busy] = await db.select({ id: schema.workloads.id }).from(schema.workloads).where(eq(schema.workloads.nodeId, id)).limit(1);
  if (busy) return { error: "This node still has workloads. Delete or move them first." };
  try {
    // A cloud machine is destroyed with its node: otherwise it would keep costing money unseen.
    await destroyCloudServer(id, admin.id);
    await db.delete(schema.nodes).where(eq(schema.nodes.id, id));
  } catch (err) {
    return { error: err instanceof CloudNodeError ? err.message : "This node still has workloads. Delete or move them first." };
  }
  await audit(admin.id, "node.deleted", "node", id);
  redirect("/admin/nodes");
}

export async function saveDnsSettings(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const nameservers = String(form.get("nameservers") ?? "").split(/[\s,]+/).map((h) => h.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  if (nameservers.some((h) => !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h))) return { error: "Enter host names such as ns1.example.com" };
  const hostmaster = String(form.get("hostmaster") ?? "").trim();
  if (hostmaster && !z.string().email().safeParse(hostmaster).success) return { error: "Enter a valid email address" };
  await updateSettings("dns", { nameservers: [...new Set(nameservers)].slice(0, 8), hostmaster });
  await audit(admin.id, "settings.updated", "settings", "dns");
  await syncDns();
  revalidatePath("/admin/dns");
  return { ok: "Saved" };
}

export async function syncDnsNow(): Promise<ActionState> {
  await requireAdmin();
  return { ok: `Queued for ${await syncDns()} node(s)` };
}

// ─── Backups ─────────────────────────────────────────────────────────────────

export async function saveBackups(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const current = await getSettings("backups");
  const parsed = z
    .object({
      keepScheduled: z.coerce.number().int().min(1).max(90),
      endpoint: z.union([z.string().trim().url().regex(/^https?:\/\//i).max(300), z.literal("")]),
      region: z.string().trim().max(60).regex(/^[a-z0-9-]*$/i),
      // S3 bucket naming rules.
      bucket: z.union([z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), z.literal("")]),
      prefix: z.string().trim().max(200).regex(/^[\w./-]*$/),
      accessKey: z.string().trim().max(200),
      keepLocal: z.enum(["0", "1"]),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` };
  const offsiteEnabled = form.has("offsiteEnabled");
  const secretKey = String(form.get("secretKey") ?? "").trim() || current.secretKey;
  if (offsiteEnabled && (!parsed.data.bucket || !parsed.data.accessKey || !secretKey)) return { error: "Bucket, access key and secret key are required" };
  await updateSettings("backups", { ...parsed.data, keepLocal: parsed.data.keepLocal === "1", offsiteEnabled, secretKey });
  await audit(admin.id, "settings.updated", "settings", "backups");
  revalidatePath("/admin/settings/backups");
  return { ok: "Saved" };
}

export async function testOffsiteStorage(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  try {
    await testOffsite(z.string().uuid().parse(form.get("nodeId")), admin.id);
  } catch (err) {
    if (err instanceof PlatformError) return { error: err.message };
    throw err;
  }
  revalidatePath("/admin/settings/backups");
  return { ok: "Test started: the result appears below in a few seconds" };
}

// ─── Electronic invoicing ────────────────────────────────────────────────────

export async function saveEinvoice(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const t = (max: number) => z.string().trim().max(max);
  const parsed = z
    .object({
      name: t(80),
      vatNumber: z.union([z.string().trim().regex(/^\d{11}$/, "11 digits"), z.literal("")]),
      fiscalCode: z.union([z.string().trim().toUpperCase().regex(/^([A-Z0-9]{16}|\d{11})$/), z.literal("")]),
      regime: z.string().regex(/^RF(0[1-9]|1[0-9]|20)$/),
      iban: z.union([z.string().trim().toUpperCase().regex(/^[A-Z]{2}\d{2}[A-Z0-9 ]{11,32}$/), z.literal("")]),
      address: t(60),
      zip: z.union([z.string().trim().regex(/^\d{5}$/), z.literal("")]),
      city: t(60),
      province: z.union([z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/), z.literal("")]),
      zeroVatNature: z.string().regex(/^N\d(\.\d)?$/),
      zeroVatNote: t(100),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` };
  const enabled = form.has("enabled");
  const d = parsed.data;
  if (enabled && (!d.name || !d.vatNumber || !d.address || !d.zip || !d.city)) return { error: "Name, VAT number and full address are required" };
  await updateSettings("einvoice", { ...d, enabled, vatCountry: "IT" });
  await audit(admin.id, "settings.updated", "settings", "einvoice");
  revalidatePath("/admin/settings/einvoice");
  return { ok: "Saved" };
}

// ─── SDI intermediaries ──────────────────────────────────────────────────────

export async function saveSdi(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const current = await getSettings("sdi");
  const provider = getSdiProvider(String(form.get("provider") ?? ""));
  const autoSend = form.get("autoSend") === "paid" ? ("paid" as const) : ("manual" as const);
  if (!provider) {
    await updateSettings("sdi", { ...current, provider: "", autoSend });
    return { ok: "Saved" };
  }
  const previous = current.accounts[provider.id] ?? {};
  const account: Record<string, string> = { sandbox: form.has("sandbox") ? "1" : "" };
  for (const f of provider.fields) account[f.name] = String(form.get(`${provider.id}.${f.name}`) ?? "").trim().slice(0, 2000) || (f.type === "password" ? (previous[f.name] ?? "") : "");
  if (provider.fields.some((f) => !account[f.name])) return { error: "Fill in every field of the chosen intermediary" };
  await updateSettings("sdi", { provider: provider.id, autoSend, accounts: { ...current.accounts, [provider.id]: account } });
  await audit(admin.id, "settings.updated", "settings", `sdi.${provider.id}`);
  revalidatePath("/admin/settings/einvoice");
  return { ok: "Saved" };
}

// ─── Cloud providers ─────────────────────────────────────────────────────────

export async function saveCloudProvider(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const provider = getCloudProvider(String(form.get("provider") ?? ""));
  if (!provider) return { error: "Unknown provider" };
  const current = await getSettings("cloud");
  const previous = current.accounts[provider.id] ?? {};
  const account: Record<string, string> = { enabled: form.has("enabled") ? "1" : "" };
  // Secrets left empty keep their saved value: they are never sent back to the browser.
  for (const f of provider.fields) account[f.name] = String(form.get(f.name) ?? "").trim().slice(0, 10_000) || (f.type === "text" ? "" : (previous[f.name] ?? ""));
  if (account.enabled && provider.fields.some((f) => !f.optional && !account[f.name])) return { error: "Fill in the credentials before enabling this provider" };
  const acmeEmail = String(form.get("acmeEmail") ?? current.acmeEmail).trim();
  if (acmeEmail && !z.string().email().safeParse(acmeEmail).success) return { error: "Enter a valid email address" };
  await updateSettings("cloud", { ...current, acmeEmail, accounts: { ...current.accounts, [provider.id]: account } });
  await audit(admin.id, "settings.updated", "settings", `cloud.${provider.id}`);
  revalidatePath("/admin/settings/cloud");
  return { ok: "Saved" };
}

export async function testCloud(_: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    return { ok: await testCloudProvider(String(form.get("provider") ?? "")) };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 300) : "The cloud provider could not be reached" };
  }
}

/** Creates a real, billed machine at the provider: only on an explicit confirmation. */
export async function createCloudServer(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  if (!form.has("confirm")) return { error: "Tick the box to confirm: the provider starts billing this server right away" };
  const parsed = z
    .object({ provider: z.string(), name: z.string().trim(), region: z.string().trim(), size: z.string().trim(), baseDomain: nodeFields.shape.baseDomain, maxWorkloads: z.coerce.number().int().min(0).default(0) })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    await createCloudNode({ ...parsed.data, origin: await baseUrl() }, admin.id);
  } catch (err) {
    if (err instanceof CloudNodeError) return { error: err.message };
    throw err;
  }
  revalidatePath("/admin/nodes");
  return { ok: "The server is being created. It installs the agent by itself and comes online in about five minutes." };
}

/** Own servers only, or let the panel create cloud servers when room runs out. */
export async function saveInfrastructureMode(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const current = await getSettings("cloud");
  const enabled = form.get("mode") === "auto";
  const parsed = z
    .object({
      provider: z.string().trim(),
      region: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{0,40}$/i).or(z.literal("")),
      size: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{0,40}$/i).or(z.literal("")),
      maxNodes: z.coerce.number().int().min(1).max(200),
      workloadsPerNode: z.coerce.number().int().min(1).max(500),
      minFreeSlots: z.coerce.number().int().min(0).max(500),
      removeEmptyAfterHours: z.coerce.number().int().min(0).max(720),
      baseDomainTemplate: z.string().trim().toLowerCase().regex(/^(\{name\}\.)([a-z0-9-]+\.)+[a-z]{2,}$/, "Use the form {name}.nodes.example.com").or(z.literal("")),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` };
  if (enabled) {
    if (current.accounts[parsed.data.provider]?.enabled !== "1") return { error: "Enable and configure the provider above first" };
    if (!parsed.data.region || !parsed.data.size) return { error: "Choose a region and a size" };
    if (!parsed.data.baseDomainTemplate) return { error: "Automatic servers need a base domain template, otherwise their sites get no address" };
  }
  await updateSettings("cloud", { ...current, autoscale: { ...parsed.data, enabled } });
  await audit(admin.id, "settings.updated", "settings", "cloud.autoscale", { enabled, provider: parsed.data.provider });
  revalidatePath("/admin/settings/cloud");
  return { ok: "Saved" };
}
