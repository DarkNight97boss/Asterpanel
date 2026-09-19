"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { IpPoolError } from "@/lib/ip-pools";
import { blockToPool, IpxoError, orderBlock, requestLoa, syncIpxoBlocks, testIpxo } from "@/lib/ipxo";
import { getSettings, updateSettings } from "@/lib/settings";

const PATH = "/admin/settings/ipxo";
const fail = (err: unknown): ActionState => {
  if (err instanceof IpxoError || err instanceof IpPoolError) return { error: err.message };
  throw err;
};

/** Leasing address space spends the company's money and decides where sites answer from: administrators only. */
export async function saveIpxo(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const current = await getSettings("ipxo");
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const next = { enabled: form.has("enabled"), clientId: text("clientId"), clientSecret: text("clientSecret") || current.clientSecret, tenantUuid: text("tenantUuid"), scopes: text("scopes") || "billing", asn: text("asn").toUpperCase().replace(/^AS/, ""), companyName: text("companyName").slice(0, 120) };
  if (next.asn && !/^\d{1,10}$/.test(next.asn)) return { error: "The AS number is a number, such as 64500" };
  if (!/^[a-z0-9_. -]{1,120}$/i.test(next.scopes)) return { error: "Scopes are words separated by spaces" };
  if (next.enabled && (!next.clientId || !next.clientSecret || !next.tenantUuid)) return { error: "The client ID, the secret and the tenant are needed before switching the integration on" };
  await updateSettings("ipxo", next);
  await audit(admin.id, "settings.updated", "settings", "ipxo");
  revalidatePath(PATH);
  return { ok: "Saved" };
}

export async function testConnection(_: ActionState): Promise<ActionState> {
  await requireAdmin();
  try {
    return { ok: await testIpxo() };
  } catch (err) {
    return fail(err);
  }
}

export async function syncNow(_: ActionState): Promise<ActionState> {
  await requireAdmin();
  try {
    await syncIpxoBlocks();
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  return { ok: "Updated" };
}

export async function order(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  if (!form.has("confirm")) return { error: "Tick the box to confirm the order" };
  try {
    await orderBlock(String(form.get("cidr") ?? ""), admin.id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  return { ok: "Ordered" };
}

export async function askLoa(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  try {
    await requestLoa(z.string().uuid().parse(form.get("id")), admin.id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  return { ok: "Requested" };
}

export async function makePool(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  try {
    await blockToPool(z.string().uuid().parse(form.get("id")), { provider: String(form.get("provider") ?? ""), region: String(form.get("region") ?? "") }, admin.id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  revalidatePath("/admin/settings/ip-pools");
  return { ok: "Saved" };
}
