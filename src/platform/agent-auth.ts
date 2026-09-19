import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { safeEqual, sha256 } from "@/lib/crypto";

/** `Authorization: Bearer <nodeId>.<token>` → the node row, or null. */
export async function authenticateAgent(request: Request) {
  const [nodeId, token] = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").split(".", 2);
  if (!token || !/^[0-9a-f-]{36}$/i.test(nodeId)) return null;
  const db = await getDb();
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
  if (!node || node.status === "disabled" || !safeEqual(sha256(token), node.tokenHash)) return null;
  return node;
}
