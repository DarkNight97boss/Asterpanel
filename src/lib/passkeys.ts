import "server-only";
import { and, eq } from "drizzle-orm";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { getDb, schema } from "@/db";
import { audit } from "./audit";

/**
 * Passkeys (WebAuthn). The cryptography is @simplewebauthn's; this file keeps
 * the credentials and decides what is asked of the browser. User verification
 * (biometrics or PIN) is always required, so a passkey is two factors in one:
 * something you have, unlocked by something you are or know.
 */

export class PasskeyError extends Error {}

export const MAX_PASSKEYS = 10;
/** Where the ceremony happens: the site's origin and its host name (the "relying party id"). */
export type Site = { origin: string; name: string };
const rpID = (site: Site) => new URL(site.origin).hostname;

export async function registrationOptions(user: { id: string; email: string; firstName: string; lastName: string }, site: Site) {
  const db = await getDb();
  const existing = await db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, user.id));
  if (existing.length >= MAX_PASSKEYS) throw new PasskeyError("You already have the maximum number of passkeys");
  return generateRegistrationOptions({
    rpName: site.name,
    rpID: rpID(site),
    userName: user.email,
    userDisplayName: `${user.firstName} ${user.lastName}`.trim() || user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    // The same authenticator twice would only confuse the list.
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports as never })),
    // Discoverable: signing in needs no email first.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
}

export async function finishRegistration(userId: string, response: RegistrationResponseJSON, challenge: string, site: Site, name: string): Promise<string> {
  const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: site.origin, expectedRPID: rpID(site), requireUserVerification: true }).catch(() => null);
  if (!result?.verified) throw new PasskeyError("The passkey could not be verified");
  const { credential } = result.registrationInfo;
  const db = await getDb();
  const [row] = await db
    .insert(schema.passkeys)
    .values({ userId, credentialId: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter, transports: credential.transports ?? [], name: name.trim().slice(0, 60) || "Passkey" })
    .onConflictDoNothing()
    .returning({ id: schema.passkeys.id });
  if (!row) throw new PasskeyError("This passkey is already registered");
  await audit(userId, "auth.passkey.added", "user", userId, { name: name.trim().slice(0, 60) });
  return row.id;
}

/** No list of credentials: the browser offers the passkeys it holds for this site. */
export const loginOptions = (site: Site) => generateAuthenticationOptions({ rpID: rpID(site), userVerification: "required" });

/** The user a signed challenge belongs to, or an error. Never says which part failed. */
export async function finishLogin(response: AuthenticationResponseJSON, challenge: string, site: Site): Promise<string> {
  const refused = new PasskeyError("This passkey was not accepted");
  const db = await getDb();
  const [row] = await db.select({ passkey: schema.passkeys, status: schema.users.status }).from(schema.passkeys).innerJoin(schema.users, eq(schema.users.id, schema.passkeys.userId)).where(eq(schema.passkeys.credentialId, String(response?.id ?? "")));
  if (!row) throw refused;
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: site.origin,
    expectedRPID: rpID(site),
    requireUserVerification: true,
    credential: { id: row.passkey.credentialId, publicKey: new Uint8Array(Buffer.from(row.passkey.publicKey, "base64url")), counter: row.passkey.counter, transports: row.passkey.transports as never },
  }).catch(() => null);
  if (!result?.verified) {
    await audit(row.passkey.userId, "auth.passkey.failed", "user", row.passkey.userId);
    throw refused;
  }
  if (row.status !== "active") throw new PasskeyError("This account is not active. Contact support.");
  await db.update(schema.passkeys).set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() }).where(eq(schema.passkeys.id, row.passkey.id));
  return row.passkey.userId;
}

export const listPasskeys = async (userId: string) => (await getDb()).select({ id: schema.passkeys.id, name: schema.passkeys.name, createdAt: schema.passkeys.createdAt, lastUsedAt: schema.passkeys.lastUsedAt }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId)).orderBy(schema.passkeys.createdAt);

export async function removePasskey(userId: string, id: string) {
  const [gone] = await (await getDb()).delete(schema.passkeys).where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, userId))).returning({ name: schema.passkeys.name });
  if (gone) await audit(userId, "auth.passkey.removed", "user", userId, { name: gone.name });
}
