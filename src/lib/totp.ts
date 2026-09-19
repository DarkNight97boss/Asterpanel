import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { decryptJson, encryptJson, sha256 } from "./crypto";

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what every authenticator app speaks. */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP = 30;

export function base32(bytes: Buffer): string {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  return (bits.match(/.{1,5}/g) ?? []).map((c) => ALPHABET[parseInt(c.padEnd(5, "0"), 2)]).join("");
}

function fromBase32(text: string): Buffer {
  const bits = [...text.replace(/=+$/, "").toUpperCase()].map((c) => ALPHABET.indexOf(c).toString(2).padStart(5, "0")).join("");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** The matching time step (±1 for clock drift), or null. */
export function matchStep(secret: string, code: string, now = Date.now()): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const current = Math.floor(now / 1000 / STEP);
  for (const step of [current, current - 1, current + 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(clean))) return step;
  }
  return null;
}

export const otpauthUrl = (issuer: string, account: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

// ─── Enrolment and verification against the database ─────────────────────────

/** Starts (or restarts) enrolment: a fresh secret that is not trusted until confirmed. */
export async function beginEnrolment(userId: string): Promise<string> {
  const secret = base32(randomBytes(20));
  const db = await getDb();
  await db.update(schema.users).set({ totpSecret: encryptJson(secret), totpEnabledAt: null, totpLastStep: 0 }).where(eq(schema.users.id, userId));
  return secret;
}

export async function pendingSecret(userId: string): Promise<string | null> {
  const db = await getDb();
  const [u] = await db.select({ s: schema.users.totpSecret, on: schema.users.totpEnabledAt }).from(schema.users).where(eq(schema.users.id, userId));
  return u?.s && !u.on ? decryptJson<string>(u.s, "") || null : null;
}

/** Confirms enrolment with a first valid code and returns one-time recovery codes (shown once). */
export async function confirmEnrolment(userId: string, code: string): Promise<string[] | null> {
  const secret = await pendingSecret(userId);
  const step = secret && matchStep(secret, code);
  if (!step) return null;
  const codes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex").replace(/(.{5})/, "$1-"));
  const db = await getDb();
  await db.update(schema.users).set({ totpEnabledAt: new Date(), totpLastStep: step, recoveryCodes: codes.map(sha256) }).where(eq(schema.users.id, userId));
  return codes;
}

/** Second factor at sign-in: an authenticator code (never reusable) or a recovery code (burned on use). */
export async function verifySecondFactor(userId: string, input: string): Promise<boolean> {
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u?.totpEnabledAt) return false;
  const step = matchStep(decryptJson<string>(u.totpSecret, ""), input);
  if (step) {
    if (step <= u.totpLastStep) return false; // replay of a code that was already accepted
    await db.update(schema.users).set({ totpLastStep: step }).where(eq(schema.users.id, userId));
    return true;
  }
  const hash = sha256(input.trim().toLowerCase());
  if (!u.recoveryCodes.includes(hash)) return false;
  await db.update(schema.users).set({ recoveryCodes: u.recoveryCodes.filter((c) => c !== hash) }).where(eq(schema.users.id, userId));
  return true;
}

export async function disableTotp(userId: string) {
  const db = await getDb();
  await db.update(schema.users).set({ totpSecret: "", totpEnabledAt: null, totpLastStep: 0, recoveryCodes: [] }).where(eq(schema.users.id, userId));
}
