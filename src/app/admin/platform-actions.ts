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
  try {
    await db.delete(schema.nodes).where(eq(schema.nodes.id, id));
  } catch {
    return { error: "This node still has workloads. Delete or move them first." };
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
