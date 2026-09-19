import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { sha256 } from "./crypto";

/**
 * The staff member behind the current session, if it is an impersonated one.
 * Kept apart from auth.ts so the audit log can use it without pulling in navigation.
 */
export const getImpersonator = cache(async (): Promise<{ id: string; name: string } | null> => {
  const token = (await cookies()).get("aster_session")?.value;
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ id: schema.users.id, firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.impersonatorId))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, new Date())));
  return row ? { id: row.id, name: `${row.firstName} ${row.lastName}`.trim() || row.email } : null;
});
