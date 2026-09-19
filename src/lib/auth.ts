import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { randomToken, sha256 } from "./crypto";
import { requestMeta } from "./request";
import { AREA_HOME, staffAreas, staffCan, type StaffArea } from "./staff";

const COOKIE = "aster_session";
const SESSION_DAYS = 14;
const DAY = 86_400_000;

/** Never carries the password hash, the TOTP secret or the recovery codes. */
export type SessionUser = Omit<typeof schema.users.$inferSelect, "passwordHash" | "totpSecret" | "recoveryCodes" | "totpLastStep">;

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

/** Public handle of a session row: the stored id is itself a secret-derived hash, so pages get a hash of it. */
export const sessionHandle = (id: string) => sha256(`handle:${id}`).slice(0, 24);

/** The signed-in user's sessions, newest first, with the current one flagged. */
export async function listSessions(userId: string) {
  const current = (await cookies()).get(COOKIE)?.value;
  const db = await getDb();
  const rows = await db.select().from(schema.sessions).where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, new Date())));
  return rows
    .map((s) => ({ handle: sessionHandle(s.id), ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, current: !!current && s.id === sha256(current) }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.getTime() - a.createdAt.getTime());
}

export async function revokeSession(userId: string, handle: string) {
  const db = await getDb();
  const rows = await db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, userId));
  const hit = rows.find((s) => sessionHandle(s.id) === handle);
  if (hit) await db.delete(schema.sessions).where(eq(schema.sessions.id, hit.id));
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
  const { passwordHash: _h, totpSecret: _s, recoveryCodes: _r, totpLastStep: _l, ...user } = row.user;
  void [_h, _s, _r, _l];
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

/** Staff whose role opens `area`. Others land on the first area they do have. */
export async function requireArea(area: StaffArea): Promise<SessionUser> {
  const user = await requireStaff();
  if (!staffCan(user, area)) redirect(AREA_HOME[staffAreas(user)[0]]);
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
