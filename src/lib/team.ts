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

export async function inviteMember(ownerId: string, actor: SessionUser, email: string, role: TeamRole) {
  const db = await getDb();
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, ownerId));
  if (owner.email === email) throw new TeamError("The account owner already has full access");
  const token = randomToken();
  // Re-inviting the same address refreshes the link and the role.
  const [row] = await db
    .insert(schema.teamMembers)
    .values({ ownerId, email, role, inviteTokenHash: sha256(token) })
    .onConflictDoUpdate({ target: [schema.teamMembers.ownerId, schema.teamMembers.email], set: { role, inviteTokenHash: sha256(token), invitedAt: new Date() }, setWhere: isNull(schema.teamMembers.acceptedAt) })
    .returning();
  if (!row) throw new TeamError("This person is already a member of the team");
  await audit(actor.id, "team.invited", "user", ownerId, { email, role });
  const sent = await sendTeamInvite({ to: email, token, role, inviter: actor, ownerId });
  return { sent, path: `/invite?token=${encodeURIComponent(token)}` };
}

export async function findInvite(token: string) {
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ invite: schema.teamMembers, owner: { firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email, company: schema.users.company } })
    .from(schema.teamMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.ownerId))
    .where(and(eq(schema.teamMembers.inviteTokenHash, sha256(token)), isNull(schema.teamMembers.acceptedAt), gt(schema.teamMembers.invitedAt, new Date(Date.now() - INVITE_DAYS * DAY))));
  return row ?? null;
}

/** The invite is bound to an email address: only that user can accept it. */
export async function acceptInvite(token: string, user: SessionUser): Promise<string> {
  const found = await findInvite(token);
  if (!found) throw new TeamError("This invitation is invalid or has expired");
  if (found.invite.email !== user.email) throw new TeamError("This invitation was sent to a different email address");
  const db = await getDb();
  await db.update(schema.teamMembers).set({ memberId: user.id, acceptedAt: new Date(), inviteTokenHash: "" }).where(eq(schema.teamMembers.id, found.invite.id));
  await audit(user.id, "team.joined", "user", found.invite.ownerId, { role: found.invite.role });
  return found.invite.ownerId;
}
