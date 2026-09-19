import "server-only";
import { getDb, schema } from "@/db";
import { getImpersonator } from "./impersonation";
import { requestMeta } from "./request";

export async function audit(
  actorId: string | null,
  action: string,
  entity = "",
  entityId = "",
  meta: Record<string, unknown> = {},
) {
  const db = await getDb();
  let ip = "";
  try {
    ip = (await requestMeta()).ip;
  } catch {
    // Outside a request (cron, scripts): no IP to record.
  }
  // Whatever staff does while acting as a client stays attributable to them.
  const staff = await getImpersonator().catch(() => null);
  await db.insert(schema.auditLog).values({ actorId, action, entity, entityId, meta: staff ? { ...meta, impersonatedBy: staff.id } : meta, ip });
}
