import "server-only";
import { cache } from "react";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TeamRole } from "@/db/schema";
import type { SessionUser } from "./auth";

/** Roles, permissions and account membership — no request state in here. */

export type AccountRole = "owner" | TeamRole;
export type Permission = "hosting" | "billing" | "manage" | "support";

const GRANTS: Record<AccountRole, Permission[]> = {
  owner: ["hosting", "billing", "manage", "support"],
  admin: ["hosting", "billing", "manage", "support"],
  developer: ["hosting", "support"],
  billing: ["billing", "support"],
};

export const ROLE_LABEL: Record<AccountRole, string> = { owner: "Owner", admin: "Administrator", developer: "Developer", billing: "Billing" };
export const roleCan = (role: AccountRole, permission: Permission) => GRANTS[role].includes(permission);

export type Account = { id: string; name: string; role: AccountRole };

const accountName = (u: Pick<SessionUser, "company" | "firstName" | "lastName" | "email">) => u.company || `${u.firstName} ${u.lastName}`.trim() || u.email;

/** Every account the user can act in: their own first, then memberships. */
export const listAccounts = cache(async (user: SessionUser): Promise<Account[]> => {
  const db = await getDb();
  const rows = await db
    .select({ role: schema.teamMembers.role, owner: schema.users })
    .from(schema.teamMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.ownerId))
    .where(and(eq(schema.teamMembers.memberId, user.id), isNotNull(schema.teamMembers.acceptedAt), eq(schema.users.status, "active")));
  return [{ id: user.id, name: accountName(user), role: "owner" }, ...rows.map((r) => ({ id: r.owner.id, name: accountName(r.owner), role: r.role }))];
});
