import "server-only";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { enforceTwoFactor, getAccount, mayAccess, roleCan } from "@/lib/account";
import { getImpersonator } from "@/lib/impersonation";
import { staffCan } from "@/lib/staff";

/**
 * Loads a workload for the signed-in user: the active account's members with
 * hosting access see it, staff with the platform area see all. "Not yours" and "does not exist" are indistinguishable (404).
 */
export async function requireWorkload(id: string) {
  const { user, account } = await getAccount();
  if (!(await getImpersonator())) enforceTwoFactor({ user, account });
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const workload = await db.query.workloads.findFirst({
    where: eq(schema.workloads.id, id),
    with: {
      node: { columns: { name: true, region: true, publicIp: true, baseDomain: true } },
      domains: { orderBy: [desc(schema.domains.isPrimary), asc(schema.domains.createdAt)] },
    },
  });
  const staff = staffCan(user, "platform");
  if (!workload || workload.status === "deleted" || (!staff && (workload.companyId !== account.id || !roleCan(account.role, "hosting") || !mayAccess(account, workload)))) notFound();
  return { user, account, workload, canManage: staff || roleCan(account.role, "manage") };
}
