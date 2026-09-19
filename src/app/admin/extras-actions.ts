"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import type { IncidentStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAdmin, requireArea } from "@/lib/auth";
import { updateSettings } from "@/lib/settings";
import { parseMoney } from "@/lib/format";

const uuid = z.string().uuid();

// ─── Coupons ─────────────────────────────────────────────────────────────────

export async function saveCoupon(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("billing");
  const f = Object.fromEntries(form);
  const code = String(f.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return { error: "Codes use letters, numbers, dashes and underscores (3 to 40 characters)" };
  const kind = f.kind === "fixed" ? "fixed" : "percent";
  const value = kind === "percent" ? Number(f.value) : parseMoney(String(f.value ?? ""));
  if (value === null || !Number.isInteger(value) || value < 1 || (kind === "percent" && value > 100)) return { error: kind === "percent" ? "Enter a percentage between 1 and 100" : "Enter an amount such as 10.00" };
  const expires = String(f.expiresAt ?? "");
  const row = { code, kind: kind as "percent" | "fixed", value, maxUses: z.coerce.number().int().min(0).max(1_000_000).catch(0).parse(f.maxUses), expiresAt: /^\d{4}-\d{2}-\d{2}$/.test(expires) ? new Date(`${expires}T23:59:59Z`) : null, enabled: true };
  await (await getDb()).insert(schema.coupons).values(row).onConflictDoUpdate({ target: schema.coupons.code, set: row });
  await audit(staff.id, "coupon.saved", "coupon", code, { kind, value });
  revalidatePath("/admin/coupons");
  return { ok: "Saved" };
}

export async function toggleCoupon(form: FormData) {
  const staff = await requireArea("billing");
  const id = uuid.parse(form.get("id"));
  const db = await getDb();
  const [c] = await db.select().from(schema.coupons).where(eq(schema.coupons.id, id));
  if (c) await db.update(schema.coupons).set({ enabled: !c.enabled }).where(eq(schema.coupons.id, id));
  await audit(staff.id, "coupon.toggled", "coupon", c?.code ?? id);
  revalidatePath("/admin/coupons");
}

// ─── Canned replies ──────────────────────────────────────────────────────────

export async function saveCannedReply(_: ActionState, form: FormData): Promise<ActionState> {
  await requireArea("support");
  const parsed = z.object({ title: z.string().trim().min(2).max(80), body: z.string().trim().min(2).max(10_000) }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Title and text are required" };
  await (await getDb()).insert(schema.cannedReplies).values(parsed.data);
  revalidatePath("/admin/canned-replies");
  return { ok: "Saved" };
}

export async function deleteCannedReply(form: FormData) {
  await requireArea("support");
  await (await getDb()).delete(schema.cannedReplies).where(eq(schema.cannedReplies.id, uuid.parse(form.get("id"))));
  revalidatePath("/admin/canned-replies");
}

// ─── Status page ─────────────────────────────────────────────────────────────

const STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;

export async function openIncident(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("platform");
  const parsed = z.object({ title: z.string().trim().min(3).max(140), impact: z.enum(["minor", "major", "maintenance"]), message: z.string().trim().min(3).max(2000) }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Title and a first message are required" };
  const { message, ...row } = parsed.data;
  const [i] = await (await getDb()).insert(schema.incidents).values({ ...row, updates: [{ at: new Date().toISOString(), status: "investigating", message }] }).returning({ id: schema.incidents.id });
  await audit(staff.id, "incident.opened", "incident", i.id, { title: row.title });
  revalidatePath("/status");
  revalidatePath("/admin/status");
  return { ok: "Published on the status page" };
}

export async function updateIncident(_: ActionState, form: FormData): Promise<ActionState> {
  const staff = await requireArea("platform");
  const parsed = z.object({ id: uuid, status: z.enum(STATUSES), message: z.string().trim().min(3).max(2000) }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Write what changed" };
  const db = await getDb();
  const [i] = await db.select().from(schema.incidents).where(eq(schema.incidents.id, parsed.data.id));
  if (!i) return { error: "Incident not found" };
  const status: IncidentStatus = parsed.data.status;
  await db.update(schema.incidents).set({ status, resolvedAt: status === "resolved" ? new Date() : null, updates: [...i.updates, { at: new Date().toISOString(), status, message: parsed.data.message }] }).where(eq(schema.incidents.id, i.id));
  await audit(staff.id, "incident.updated", "incident", i.id, { status });
  revalidatePath("/status");
  revalidatePath("/admin/status");
  return { ok: "Published on the status page" };
}

// ─── Support targets ─────────────────────────────────────────────────────────

export async function saveSla(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const hours = z.coerce.number().int().min(1).max(720);
  const parsed = z.object({ slaLow: hours, slaMedium: hours, slaHigh: hours }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Enter hours between 1 and 720" };
  await updateSettings("support", parsed.data);
  await audit(admin.id, "settings.updated", "settings", "support");
  revalidatePath("/admin/tickets");
  return { ok: "Saved" };
}
