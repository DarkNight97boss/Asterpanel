"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { getDb, schema } from "@/db";
import { ACCOUNT_COOKIE, listAccounts, requireAccount } from "@/lib/account";
import { audit } from "@/lib/audit";
import { requireUser, stopImpersonation } from "@/lib/auth";
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

const M = schema.companyMembers;
/** A member row of the active company that is not its owner. */
const memberOf = (companyId: string, id: string) => and(eq(M.id, id), eq(M.companyId, companyId), ne(M.role, "owner"));

export async function changeRole(form: FormData) {
  const { user, account } = await requireAccount("manage");
  const parsed = z.object({ id: z.string().uuid(), role }).parse(Object.fromEntries(form));
  const db = await getDb();
  await db.update(M).set({ role: parsed.role }).where(memberOf(account.id, parsed.id));
  await audit(user.id, "team.role_changed", "company", account.id, parsed);
  revalidatePath("/client/team");
}

export async function removeMember(form: FormData) {
  const { user, account } = await requireAccount("manage");
  const id = z.string().uuid().parse(form.get("id"));
  const db = await getDb();
  const [gone] = await db.delete(M).where(memberOf(account.id, id)).returning({ email: M.email });
  if (gone) await audit(user.id, "team.removed", "company", account.id, { email: gone.email });
  revalidatePath("/client/team");
}

/** Leave a company you were invited to. Owners hand the company over first. */
export async function leaveTeam(form: FormData) {
  const user = await requireUser();
  const companyId = z.string().uuid().parse(form.get("companyId"));
  const db = await getDb();
  const [gone] = await db.delete(M).where(and(eq(M.companyId, companyId), eq(M.userId, user.id), ne(M.role, "owner"))).returning({ email: M.email });
  if (gone) await audit(user.id, "team.left", "company", companyId, { email: gone.email });
  (await cookies()).delete(ACCOUNT_COOKIE);
  redirect("/client");
}

/** Only the owner can hand the company to another active member; the old owner stays as administrator. */
export async function transferOwnership(form: FormData) {
  const { user, account } = await requireAccount("manage");
  if (account.role !== "owner") redirect("/client/team");
  const id = z.string().uuid().parse(form.get("id"));
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [next] = await tx.select().from(M).where(and(memberOf(account.id, id), isNotNull(M.acceptedAt)));
    if (!next) return;
    await tx.update(M).set({ role: "admin" }).where(and(eq(M.companyId, account.id), eq(M.role, "owner")));
    await tx.update(M).set({ role: "owner", workloadIds: null }).where(eq(M.id, next.id));
    await tx.insert(schema.auditLog).values({ actorId: user.id, action: "team.ownership_transferred", entity: "company", entityId: account.id, meta: { email: next.email } });
  });
  revalidatePath("/client", "layout");
}

export async function setRequire2fa(_: ActionState, form: FormData): Promise<ActionState> {
  const { user, account } = await requireAccount("manage");
  const on = form.get("require2fa") === "1";
  // Whoever switches it on must already comply, or they would lock themselves out of undoing it.
  if (on && !user.totpEnabledAt) return { error: "Turn on two-factor authentication for your own account first (Profile)" };
  await (await getDb()).update(schema.companies).set({ require2fa: on }).where(eq(schema.companies.id, account.id));
  await audit(user.id, on ? "company.2fa_required" : "company.2fa_optional", "company", account.id);
  revalidatePath("/client/team");
  return { ok: "Saved" };
}

export async function endImpersonation() {
  await stopImpersonation();
  redirect("/admin/clients");
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
  const mine = new Set((await db.select({ id: schema.workloads.id }).from(schema.workloads).where(eq(schema.workloads.companyId, account.id))).map((w) => w.id));
  const workloadIds = wanted.filter((w) => mine.has(w));
  await db.update(M).set({ workloadIds: workloadIds.length ? workloadIds : null }).where(memberOf(account.id, id));
  await audit(user.id, "team.sites_changed", "company", account.id, { id, count: workloadIds.length });
  revalidatePath("/client/team");
}
