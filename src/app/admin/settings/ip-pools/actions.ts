"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { assignAddress, createIpPool, deleteIpPool, IpPoolError, releaseAddress } from "@/lib/ip-pools";

const PATH = "/admin/settings/ip-pools";
const fail = (err: unknown): ActionState => {
  if (err instanceof IpPoolError) return { error: err.message };
  throw err;
};

/** Address pools decide which public IPs customers' sites answer from: administrators only. */
export async function newPool(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const f = Object.fromEntries(form);
  try {
    await createIpPool({ name: String(f.name ?? ""), provider: String(f.provider ?? ""), region: String(f.region ?? ""), mode: f.mode === "block" ? "block" : "reserved", cidr: String(f.cidr ?? ""), autoLease: form.has("autoLease") }, admin.id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  return { ok: "Saved" };
}

export async function togglePool(form: FormData) {
  const admin = await requireAdmin();
  const id = z.string().uuid().parse(form.get("id"));
  const db = await getDb();
  const [pool] = await db.select().from(schema.ipPools).where(eq(schema.ipPools.id, id));
  if (pool) await db.update(schema.ipPools).set({ autoLease: !pool.autoLease }).where(eq(schema.ipPools.id, id));
  await audit(admin.id, "ippool.autolease", "ip_pool", id, { autoLease: !pool?.autoLease });
  revalidatePath(PATH);
}

export async function releaseIp(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  try {
    await releaseAddress(z.string().uuid().parse(form.get("id")), admin.id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  return { ok: "Released" };
}

export async function removePool(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  try {
    await deleteIpPool(z.string().uuid().parse(form.get("id")), admin.id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  return { ok: "Removed" };
}

export async function assignIp(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  try {
    await assignAddress(z.string().uuid().parse(form.get("poolId")), z.string().uuid().parse(form.get("nodeId")), admin.id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(PATH);
  return { ok: "Saved" };
}
