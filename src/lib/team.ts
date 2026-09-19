import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TeamRole } from "@/db/schema";
import { audit } from "./audit";
import type { SessionUser } from "./auth";
import { randomToken, sha256 } from "./crypto";
import { sendTeamInvite } from "./notify";

const INVITE_DAYS = 7;
const DAY = 86_400_000;

export class TeamError extends Error {}

export async function inviteMember(companyId: string, actor: SessionUser, email: string, role: TeamRole) {
  const db = await getDb();
  const [existing] = await db.select().from(schema.companyMembers).where(and(eq(schema.companyMembers.companyId, companyId), eq(schema.companyMembers.email, email)));
  if (existing?.role === "owner") throw new TeamError("The company owner already has full access");
  if (existing?.acceptedAt) throw new TeamError("This person is already a member of the company");
  const token = randomToken();
  // Re-inviting the same address refreshes the link and the role.
  await db
    .insert(schema.companyMembers)
    .values({ companyId, email, role, inviteTokenHash: sha256(token) })
    .onConflictDoUpdate({ target: [schema.companyMembers.companyId, schema.companyMembers.email], set: { role, inviteTokenHash: sha256(token), invitedAt: new Date() } });
  await audit(actor.id, "team.invited", "company", companyId, { email, role });
  const sent = await sendTeamInvite({ to: email, token, role, inviter: actor, companyId });
  return { sent, path: `/invite?token=${encodeURIComponent(token)}` };
}

export async function findInvite(token: string) {
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ invite: schema.companyMembers, company: { id: schema.companies.id, name: schema.companies.name } })
    .from(schema.companyMembers)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.companyMembers.companyId))
    .where(and(eq(schema.companyMembers.inviteTokenHash, sha256(token)), isNull(schema.companyMembers.acceptedAt), gt(schema.companyMembers.invitedAt, new Date(Date.now() - INVITE_DAYS * DAY))));
  return row ?? null;
}

/** The invite is bound to an email address: only that user can accept it. */
export async function acceptInvite(token: string, user: SessionUser): Promise<string> {
  const found = await findInvite(token);
  if (!found) throw new TeamError("This invitation is invalid or has expired");
  if (found.invite.email !== user.email) throw new TeamError("This invitation was sent to a different email address");
  const db = await getDb();
  await db.update(schema.companyMembers).set({ userId: user.id, acceptedAt: new Date(), inviteTokenHash: "" }).where(eq(schema.companyMembers.id, found.invite.id));
  await audit(user.id, "team.joined", "company", found.company.id, { role: found.invite.role });
  return found.company.id;
}
