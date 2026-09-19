import { and, desc, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { apiAuth, json, siteJson } from "@/lib/api";

export const dynamic = "force-dynamic";

/** GET /api/v1/sites — every service of the company (sites, apps, databases, static sites). */
export async function GET(request: Request) {
  const caller = await apiAuth(request);
  if (caller instanceof Response) return caller;
  const rows = await (await getDb()).query.workloads.findMany({ where: and(eq(schema.workloads.companyId, caller.companyId), ne(schema.workloads.status, "deleted")), with: { domains: true }, orderBy: desc(schema.workloads.createdAt) });
  return json({ data: rows.map(siteJson) });
}
