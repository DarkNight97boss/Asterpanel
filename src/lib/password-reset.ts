import "server-only";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { hashPassword, randomToken, sha256 } from "./crypto";
import { notify, sendPasswordReset } from "./notify";

export const RESET_MINUTES = 60;

/**
 * Starts a reset for `email`. Deliberately returns nothing: the caller shows
 * the same message whether or not the account exists, so the form cannot be
 * used to discover which emails are registered.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const db = await getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email), columns: { id: true, status: true } });
  if (!user || user.status !== "active") return;

  const token = randomToken();
  // One live token per user: asking again invalidates the previous link.
  await db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, user.id));
  await db
    .insert(schema.passwordResets)
    .values({ id: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000) });
  await db.delete(schema.passwordResets).where(lt(schema.passwordResets.expiresAt, new Date()));

  const result = await sendPasswordReset(user.id, token, RESET_MINUTES);
  await audit(user.id, result.ok ? "auth.reset.requested" : "auth.reset.mail_failed", "user", user.id);
}

export async function resetTokenIsValid(token: string): Promise<boolean> {
  if (!token) return false;
  const db = await getDb();
  const [row] = await db
    .select({ id: schema.passwordResets.id })
    .from(schema.passwordResets)
    .where(and(eq(schema.passwordResets.id, sha256(token)), gt(schema.passwordResets.expiresAt, new Date())))
    .limit(1);
  return !!row;
}

/** Single use: the token row is deleted atomically before the password changes. */
export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  const db = await getDb();
  const [used] = await db
    .delete(schema.passwordResets)
    .where(and(eq(schema.passwordResets.id, sha256(token)), gt(schema.passwordResets.expiresAt, new Date())))
    .returning({ userId: schema.passwordResets.userId });
  if (!used) return false;

  await db.update(schema.users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(schema.users.id, used.userId));
  // Whoever had access before the reset is signed out everywhere.
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, used.userId));
  await audit(used.userId, "auth.reset.completed", "user", used.userId);
  notify.passwordChanged(used.userId);
  return true;
}
