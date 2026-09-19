import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { apiAuth, json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caller = await apiAuth(request);
  if (caller instanceof Response) return caller;
  const rows = await (await getDb()).select().from(schema.domainNames).where(eq(schema.domainNames.companyId, caller.companyId)).orderBy(desc(schema.domainNames.createdAt));
  return json({ data: rows.map((d) => ({ id: d.id, name: d.name, status: d.status, expiresAt: d.expiresAt, nameservers: d.nameservers, locked: d.locked })) });
}
