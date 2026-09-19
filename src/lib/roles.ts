import "server-only";
import { cache } from "react";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CompanyRole } from "@/db/schema";
import type { SessionUser } from "./auth";

/** Companies, roles and permissions — no request state in here. */

export type AccountRole = CompanyRole;
export type Permission = "hosting" | "billing" | "manage" | "support";

const GRANTS: Record<AccountRole, Permission[]> = {
  owner: ["hosting", "billing", "manage", "support"],
  admin: ["hosting", "billing", "manage", "support"],
  developer: ["hosting", "support"],
  billing: ["billing", "support"],
};

export const ROLE_LABEL: Record<AccountRole, string> = { owner: "Company owner", admin: "Company administrator", developer: "Company developer", billing: "Company billing" };
export const roleCan = (role: AccountRole, permission: Permission) => GRANTS[role].includes(permission);

/**
 * The active company as seen by one member. `id` is the company id; `ownerUserId`
 * is the person invoices and notifications are addressed to. `only` lists the
 * services a restricted developer may touch (null = all).
 */
export type Account = { id: string; name: string; role: AccountRole; only: string[] | null; ownerUserId: string; /** The company demands two-factor authentication from its members. */ require2fa: boolean };

/** True when the member may act on this service (staging follows its live site). */
export const mayAccess = (account: Pick<Account, "only">, w: { id: string; parentId?: string | null }) =>
  !account.only || account.only.includes(w.id) || (!!w.parentId && account.only.includes(w.parentId));

const personName = (u: Pick<SessionUser, "company" | "firstName" | "lastName" | "email">) => u.company || `${u.firstName} ${u.lastName}`.trim() || u.email;

/** Creates a company owned by `user`. */
export async function createCompany(user: Pick<SessionUser, "id" | "email">, name: string, details: Partial<typeof schema.companies.$inferInsert> = {}): Promise<string> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [company] = await tx.insert(schema.companies).values({ ...details, name: name.trim().slice(0, 120) || user.email }).returning({ id: schema.companies.id });
    await tx.insert(schema.companyMembers).values({ companyId: company.id, userId: user.id, email: user.email, role: "owner", acceptedAt: new Date() });
    return company.id;
  });
}

/** Every company the user belongs to, oldest membership first. A user without one gets their first company here. */
export const listAccounts = cache(async (user: SessionUser): Promise<Account[]> => {
  const db = await getDb();
  const load = () =>
    db
      .select({ m: schema.companyMembers, c: schema.companies })
      .from(schema.companyMembers)
      .innerJoin(schema.companies, eq(schema.companies.id, schema.companyMembers.companyId))
      .where(and(eq(schema.companyMembers.userId, user.id), isNotNull(schema.companyMembers.acceptedAt)))
      .orderBy(asc(schema.companyMembers.invitedAt));
  let rows = await load();
  if (!rows.length) {
    await createCompany(user, personName(user), { orgType: user.company ? "company" : "individual", billingName: user.company, vatId: user.vatId, address1: user.address, city: user.city, zip: user.zip, state: user.state, country: user.country });
    rows = await load();
  }
  const owners = await db.select({ companyId: schema.companyMembers.companyId, userId: schema.companyMembers.userId }).from(schema.companyMembers).where(eq(schema.companyMembers.role, "owner"));
  const ownerOf = new Map(owners.map((o) => [o.companyId, o.userId]));
  return rows.map(({ m, c }) => ({
    id: c.id,
    name: c.name,
    role: m.role,
    // A restriction only makes sense for people who manage services.
    only: m.role === "developer" && m.workloadIds?.length ? m.workloadIds : null,
    ownerUserId: ownerOf.get(c.id) ?? user.id,
    require2fa: c.require2fa,
  }));
});
