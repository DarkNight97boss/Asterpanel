import { and, desc, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { apiAuth, apiError, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import * as engine from "@/platform/engine";

export const dynamic = "force-dynamic";

async function site(companyId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [w] = await (await getDb()).select().from(schema.workloads).where(and(eq(schema.workloads.id, id), eq(schema.workloads.companyId, companyId), ne(schema.workloads.status, "deleted")));
  return w;
}

/** GET /api/v1/sites/:id/backups | deployments */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const caller = await apiAuth(request);
  if (caller instanceof Response) return caller;
  const { id, action } = await params;
  const w = await site(caller.companyId, id);
  if (!w) return apiError(404, "not_found", "No such site");
  const db = await getDb();
  if (action === "backups") return json({ data: (await db.select().from(schema.backups).where(eq(schema.backups.workloadId, w.id)).orderBy(desc(schema.backups.createdAt)).limit(100)).map((b) => ({ id: b.id, kind: b.kind, status: b.status, note: b.note, sizeBytes: b.sizeBytes, offsite: b.offsite, createdAt: b.createdAt })) });
  if (action === "deployments") return json({ data: (await db.select().from(schema.deployments).where(eq(schema.deployments.workloadId, w.id)).orderBy(desc(schema.deployments.createdAt)).limit(50)).map((d) => ({ id: d.id, status: d.status, trigger: d.trigger, commit: d.commitSha, message: d.commitMessage, createdAt: d.createdAt, finishedAt: d.finishedAt })) });
  return apiError(404, "not_found", "Unknown resource");
}

/** POST /api/v1/sites/:id/deploy | restart | purge-cache | backups — all asynchronous: they answer 202 with what was queued. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const caller = await apiAuth(request, true);
  if (caller instanceof Response) return caller;
  const { id, action } = await params;
  const w = await site(caller.companyId, id);
  if (!w) return apiError(404, "not_found", "No such site");
  try {
    let queued: Record<string, string>;
    if (action === "deploy") queued = { deploymentId: await engine.deployWorkload(w.id, "manual", caller.createdBy) };
    else if (action === "restart") {
      await engine.powerWorkload(w.id, "restart", caller.createdBy);
      queued = { action: "restart" };
    }
    else if (action === "purge-cache") queued = { jobId: await engine.runTool(w.id, "cache.purge", {}, caller.createdBy) };
    else if (action === "backups") {
      const body = (await request.json().catch(() => ({}))) as { note?: unknown };
      queued = { backupId: await engine.createBackup(w.id, String(body.note ?? "API").slice(0, 200), "manual", caller.createdBy) };
    } else return apiError(404, "not_found", "Unknown action");
    await audit(caller.createdBy, `api.${action}`, "workload", w.id, { key: caller.keyId });
    return json({ data: queued }, 202);
  } catch (err) {
    if (err instanceof engine.PlatformError) return apiError(409, "not_possible", err.message);
    throw err;
  }
}
