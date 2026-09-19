"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { ACCOUNT_COOKIE, listAccounts, requireAccount } from "@/lib/account";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { inviteMember, TeamError } from "@/lib/team";
import { baseUrl } from "@/lib/url";

const role = z.enum(["admin", "developer", "billing"]);

export async function invite(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("manage");
  const parsed = z.object({ email: z.string().trim().toLowerCase().email(), role }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Enter a valid email address" };
  if (!rateLimit(`invite:${account.id}`, 20, 60 * 60_000)) return { error: "Too many attempts. Try again in a few minutes." };
  try {
    const { sent, path } = await inviteMember(account.id, user, parsed.data.email, parsed.data.role);
    revalidatePath("/client/team");
    if (sent.ok) return { ok: "Invitation sent" };
    // No working mailer: hand the link to the inviter. It only works for the invited address.
    return { ok: `The email could not be sent (${sent.error}). Share this link with ${parsed.data.email}:\n${(await baseUrl())}${path}` };
  } catch (err) {
    if (err instanceof TeamError) return { error: err.message };
    throw err;
  }
}

export async function changeRole(form: FormData) {
  const { user, account } = await requireAccount("manage");
  const parsed = z.object({ id: z.string().uuid(), role }).parse(Object.fromEntries(form));
  const db = await getDb();
  await db.update(schema.teamMembers).set({ role: parsed.role }).where(and(eq(schema.teamMembers.id, parsed.id), eq(schema.teamMembers.ownerId, account.id)));
  await audit(user.id, "team.role_changed", "user", account.id, parsed);
  revalidatePath("/client/team");
}

export async function removeMember(form: FormData) {
  const { user, account } = await requireAccount("manage");
  const id = z.string().uuid().parse(form.get("id"));
  const db = await getDb();
  await db.delete(schema.teamMembers).where(and(eq(schema.teamMembers.id, id), eq(schema.teamMembers.ownerId, account.id)));
  await audit(user.id, "team.removed", "user", account.id, { id });
  revalidatePath("/client/team");
}

/** Leave a team you were invited to. */
export async function leaveTeam(form: FormData) {
  const user = await requireUser();
  const db = await getDb();
  await db.delete(schema.teamMembers).where(and(eq(schema.teamMembers.ownerId, z.string().uuid().parse(form.get("ownerId"))), eq(schema.teamMembers.memberId, user.id)));
  (await cookies()).delete(ACCOUNT_COOKIE);
  redirect("/client");
}

export async function switchAccount(form: FormData) {
  const user = await requireUser();
  const wanted = String(form.get("accountId") ?? "");
  // Only accounts the user really belongs to can be selected.
  if ((await listAccounts(user)).some((a) => a.id === wanted)) {
    (await cookies()).set(ACCOUNT_COOKIE, wanted, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  }
  redirect("/client");
}

/** Limits a developer to the ticked services; none ticked = every service. */
export async function setMemberSites(form: FormData) {
  const { user, account } = await requireAccount("manage");
  const id = z.string().uuid().parse(form.get("id"));
  const wanted = form.getAll("workloadId").map(String).filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  const db = await getDb();
  // Only services of this very account can be granted.
  const mine = new Set((await db.select({ id: schema.workloads.id }).from(schema.workloads).where(eq(schema.workloads.clientId, account.id))).map((w) => w.id));
  const workloadIds = wanted.filter((w) => mine.has(w));
  await db.update(schema.teamMembers).set({ workloadIds: workloadIds.length ? workloadIds : null }).where(and(eq(schema.teamMembers.id, id), eq(schema.teamMembers.ownerId, account.id)));
  await audit(user.id, "team.sites_changed", "user", account.id, { id, count: workloadIds.length });
  revalidatePath("/client/team");
}
