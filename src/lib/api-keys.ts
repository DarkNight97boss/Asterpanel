import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { randomToken, sha256 } from "./crypto";

/** Tokens look like `ak_live_…`: easy to spot in a leak scanner, useless without the secret part. */
const PREFIX = "ak_live_";

export async function createApiKey(input: { companyId: string; name: string; scope: "read" | "write"; createdBy: string | null; expiresInDays?: number }): Promise<{ id: string; token: string }> {
  const token = `${PREFIX}${randomToken(32)}`;
  const db = await getDb();
  const [row] = await db
    .insert(schema.apiKeys)
    .values({ companyId: input.companyId, name: input.name.trim().slice(0, 60) || "API key", scope: input.scope, createdBy: input.createdBy, prefix: token.slice(0, PREFIX.length + 6), tokenHash: sha256(token), expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null })
    .returning({ id: schema.apiKeys.id });
  // The only moment the token exists in clear text.
  return { id: row.id, token };
}

export type ApiCaller = { keyId: string; companyId: string; scope: "read" | "write"; createdBy: string | null };

/** Resolves an `Authorization: Bearer` value. Unknown, expired and malformed tokens look the same. */
export async function verifyApiKey(header: string | null): Promise<ApiCaller | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
  if (!token?.startsWith(PREFIX) || token.length > 200) return null;
  const db = await getDb();
  const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.tokenHash, sha256(token)));
  if (!key || (key.expiresAt && key.expiresAt < new Date())) return null;
  // Coarse "last used": at most one write a minute per key.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, key.id));
  return { keyId: key.id, companyId: key.companyId, scope: key.scope, createdBy: key.createdBy };
}

export const listApiKeys = async (companyId: string) => (await getDb()).select().from(schema.apiKeys).where(eq(schema.apiKeys.companyId, companyId)).orderBy(desc(schema.apiKeys.createdAt));

export const revokeApiKey = async (companyId: string, id: string) => (await getDb()).delete(schema.apiKeys).where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.companyId, companyId)));
