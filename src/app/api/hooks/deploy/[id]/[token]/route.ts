import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { safeEqual } from "@/lib/crypto";
import { rateLimit } from "@/lib/rate-limit";
import { handlePush, parsePush, PlatformError } from "@/platform/engine";

export const dynamic = "force-dynamic";

/**
 * Push-to-deploy webhook. The secret in the URL is the only credential.
 * With a GitHub / GitLab push payload it knows the branch: the app's branch
 * deploys, other branches become previews when those are switched on.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; token: string }> }) {
  const { id, token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const db = await getDb();
  const [w] = await db.select().from(schema.workloads).where(and(eq(schema.workloads.id, id), ne(schema.workloads.status, "deleted")));
  if (!w || !w.deployHookToken || !safeEqual(token, w.deployHookToken)) return Response.json({ error: "Not found" }, { status: 404 });
  // A noisy repository must not be able to queue hundreds of builds.
  if (!rateLimit(`deploy:${w.id}`, 12, 10 * 60_000)) return Response.json({ error: "Too many deploys, slow down" }, { status: 429 });
  // Payloads are small; anything else is treated as a plain "deploy now".
  const raw = Number(request.headers.get("content-length") ?? 0) <= 1_000_000 ? await request.text().catch(() => "") : "";
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {}
  try {
    const result = await handlePush(w.id, parsePush(body));
    return Response.json(result, { status: result.action === "ignored" ? 200 : 202 });
  } catch (err) {
    if (err instanceof PlatformError) return Response.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
