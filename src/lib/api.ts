import "server-only";
import type { schema } from "@/db";
import { verifyApiKey, type ApiCaller } from "./api-keys";
import { rateLimit } from "./rate-limit";

/** Shared plumbing of the public REST API (`/api/v1`). Errors are `{ error: { code, message } }`. */

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
export const apiError = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

/** Authenticates the request; `write` also demands a read-write key. Returns a Response to send back on failure. */
export async function apiAuth(request: Request, write = false): Promise<ApiCaller | Response> {
  const caller = await verifyApiKey(request.headers.get("authorization"));
  if (!caller) return apiError(401, "unauthorized", "Missing or invalid API key. Send it as: Authorization: Bearer <key>");
  if (!rateLimit(`api:${caller.keyId}`, 120, 60_000)) return apiError(429, "rate_limited", "Too many requests: 120 per minute per key");
  if (write && caller.scope !== "write") return apiError(403, "read_only_key", "This key is read-only");
  return caller;
}

export const siteJson = (w: typeof schema.workloads.$inferSelect & { domains: { hostname: string; isPrimary: boolean }[] }) => ({
  id: w.id,
  name: w.name,
  type: w.type,
  environment: w.environment,
  status: w.status,
  labels: w.labels,
  primaryDomain: w.domains.find((d) => d.isPrimary)?.hostname ?? null,
  domains: w.domains.map((d) => d.hostname),
  createdAt: w.createdAt,
});

