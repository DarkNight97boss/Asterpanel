"use server";

import { revalidatePath } from "next/cache";
import { and, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { hashPassword, randomToken } from "@/lib/crypto";
import { requestPasswordReset } from "@/lib/password-reset";
import { STAFF_ROLES } from "@/lib/staff";

const roleField = z.enum(["admin", ...STAFF_ROLES]);
const split = (r: z.infer<typeof roleField>) => (r === "admin" ? { role: "admin" as const, staffRole: "" as const } : { role: "staff" as const, staffRole: r });

/** Adds a colleague: an existing account is promoted, a new one gets a link to choose its password. */
export async function addStaff(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = z.object({ email: z.string().trim().toLowerCase().email(), firstName: z.string().trim().max(80), lastName: z.string().trim().max(80), role: roleField }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Enter a valid email address" };
  const { email, role, ...name } = parsed.data;
  const db = await getDb();
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (existing && existing.role !== "client") return { error: "This person is already in the staff" };
  if (existing) {
    await db.update(schema.users).set(split(role)).where(eq(schema.users.id, existing.id));
    // New privileges start from a fresh sign-in.
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, existing.id));
  } else {
    // Nobody knows this password: the account is opened through the reset link.
    await db.insert(schema.users).values({ email, ...name, ...split(role), passwordHash: await hashPassword(randomToken()) });
    await requestPasswordReset(email);
  }
  await audit(admin.id, "staff.added", "user", existing?.id ?? "", { email, role });
  revalidatePath("/admin/staff");
  return { ok: existing ? "Added. They need to sign in again." : "Added. We emailed them a link to choose a password." };
}

/** An installation must always keep one administrator, and nobody edits their own role. */
async function guard(adminId: string, targetId: string): Promise<string | null> {
  if (adminId === targetId) return "You cannot change your own role";
  const db = await getDb();
  const [target] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, targetId));
  if (!target || target.role === "client") return "This person is not in the staff";
  if (target.role === "admin") {
    const [{ n }] = await db.select({ n: count() }).from(schema.users).where(and(eq(schema.users.role, "admin"), ne(schema.users.id, targetId), eq(schema.users.status, "active")));
    if (!n) return "There must be at least one administrator";
  }
  return null;
}

export async function changeStaffRole(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const { id, role } = z.object({ id: z.string().uuid(), role: roleField }).parse(Object.fromEntries(form));
  const problem = await guard(admin.id, id);
  if (problem) return { error: problem };
  const db = await getDb();
  await db.update(schema.users).set(split(role)).where(eq(schema.users.id, id));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
  await audit(admin.id, "staff.role_changed", "user", id, { role });
  revalidatePath("/admin/staff");
  return { ok: "Saved" };
}

/** Back to a normal client account; every open session is closed. */
export async function removeStaff(_: ActionState, form: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = z.string().uuid().parse(form.get("id"));
  const problem = await guard(admin.id, id);
  if (problem) return { error: problem };
  const db = await getDb();
  await db.update(schema.users).set({ role: "client", staffRole: "" }).where(eq(schema.users.id, id));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
  await audit(admin.id, "staff.removed", "user", id);
  revalidatePath("/admin/staff");
  return { ok: "Removed from the staff" };
}
