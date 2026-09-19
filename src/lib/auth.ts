import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { randomToken, sha256 } from "./crypto";
import { requestMeta } from "./request";

const COOKIE = "aster_session";
const SESSION_DAYS = 14;
const DAY = 86_400_000;

export type SessionUser = Omit<typeof schema.users.$inferSelect, "passwordHash">;

export async function createSession(userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY);
  const db = await getDb();
  await db.insert(schema.sessions).values({ id: sha256(token), userId, expiresAt, ...(await requestMeta()) });
  // Opportunistic cleanup keeps the table small without a dedicated job.
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
  }
  jar.delete(COOKIE);
}

/** Revoke every session of a user, e.g. after a password change. */
export async function destroyAllSessions(userId: string) {
  const db = await getDb();
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

export const getUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || row.user.status !== "active") return null;
  const { passwordHash: _omit, ...user } = row.user;
  void _omit;
  return user;
});

export const isStaff = (user: Pick<SessionUser, "role"> | null) =>
  user?.role === "admin" || user?.role === "staff";

/** Any signed-in user. Redirects to the login page otherwise. */
export async function requireUser(next = "/client"): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

/** Staff or admin. Clients get bounced to their own area. */
export async function requireStaff(): Promise<SessionUser> {
  const user = await requireUser("/admin");
  if (!isStaff(user)) redirect("/client");
  return user;
}

/** Admin only — settings, staff management, gateways. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireStaff();
  if (user.role !== "admin") redirect("/admin");
  return user;
}

export { displayName } from "./format";

/** Only allow same-site relative redirects. */
export function safeNext(next: unknown, fallback: string): string {
  return typeof next === "string" && /^\/(?!\/)/.test(next) && !next.includes("\\") ? next : fallback;
}
