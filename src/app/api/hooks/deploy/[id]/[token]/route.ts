import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { safeEqual } from "@/lib/crypto";
import { rateLimit } from "@/lib/rate-limit";
import { deployWorkload, PlatformError } from "@/platform/engine";

export const dynamic = "force-dynamic";

/** Push-to-deploy webhook. The secret in the URL is the only credential. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string; token: string }> }) {
  const { id, token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const db = await getDb();
  const [w] = await db.select().from(schema.workloads).where(and(eq(schema.workloads.id, id), ne(schema.workloads.status, "deleted")));
  if (!w || !w.deployHookToken || !safeEqual(token, w.deployHookToken)) return Response.json({ error: "Not found" }, { status: 404 });
  // A noisy repository must not be able to queue hundreds of builds.
  if (!rateLimit(`deploy:${w.id}`, 6, 10 * 60_000)) return Response.json({ error: "Too many deploys, slow down" }, { status: 429 });
  try {
    return Response.json({ deploymentId: await deployWorkload(w.id, "push") }, { status: 202 });
  } catch (err) {
    if (err instanceof PlatformError) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
