import "server-only";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getAccount, roleCan } from "@/lib/account";
import { isStaff } from "@/lib/auth";

/**
 * Loads a workload for the signed-in user: the active account's members with
 * hosting access see it, staff see all. "Not yours" and "does not exist" are indistinguishable (404).
 */
export async function requireWorkload(id: string) {
  const { user, account } = await getAccount();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await getDb();
  const workload = await db.query.workloads.findFirst({
    where: eq(schema.workloads.id, id),
    with: {
      node: { columns: { name: true, region: true, publicIp: true, baseDomain: true } },
      domains: { orderBy: [desc(schema.domains.isPrimary), asc(schema.domains.createdAt)] },
    },
  });
  if (!workload || workload.status === "deleted" || (!isStaff(user) && (workload.clientId !== account.id || !roleCan(account.role, "hosting")))) notFound();
  return { user, account, workload, canManage: isStaff(user) || roleCan(account.role, "manage") };
}
