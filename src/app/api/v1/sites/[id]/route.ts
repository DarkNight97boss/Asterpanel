import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { apiAuth, apiError, json, siteJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const caller = await apiAuth(request);
  if (caller instanceof Response) return caller;
  const id = (await params).id;
  const w = /^[0-9a-f-]{36}$/i.test(id) ? await (await getDb()).query.workloads.findFirst({ where: and(eq(schema.workloads.id, id), eq(schema.workloads.companyId, caller.companyId), ne(schema.workloads.status, "deleted")), with: { domains: true } }) : undefined;
  return w ? json({ data: siteJson(w) }) : apiError(404, "not_found", "No such site");
}
