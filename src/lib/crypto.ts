import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// ─── Application secret ──────────────────────────────────────────────────────

let cachedSecret: Buffer | undefined;

/**
 * 32-byte key derived from APP_SECRET. Production must set it explicitly;
 * in development one is generated once and kept in `.data/app-secret`.
 */
function appKey(): Buffer {
  if (cachedSecret) return cachedSecret;
  let secret = process.env.APP_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_SECRET is required in production (openssl rand -hex 32)");
    }
    const file = path.join(process.cwd(), ".data", "app-secret");
    if (existsSync(file)) {
      secret = readFileSync(file, "utf8").trim();
    } else {
      secret = randomBytes(32).toString("hex");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  cachedSecret = createHash("sha256").update(secret).digest();
  return cachedSecret;
}

// ─── Passwords (scrypt) ──────────────────────────────────────────────────────

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, p = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: p.maxmem }, (e, k) =>
      e ? reject(e) : resolve(k),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), {
    ...SCRYPT,
    N: Number(N),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ─── Secrets at rest (AES-256-GCM) ───────────────────────────────────────────

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", appKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptJson<T>(payload: string, fallback: T): T {
  if (!payload) return fallback;
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1") throw new Error("Unknown secret payload version");
  const decipher = createDecipheriv("aes-256-gcm", appKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

// ─── Short-lived signed values (e.g. "password ok, second factor pending") ───

/** Short keyed fingerprint of a value: proves a token was made here, without expiry. */
export const macOf = (value: string, length = 16) => createHmac("sha256", appKey()).update(`mac:${value}`).digest("hex").slice(0, length);

export function signValue(value: string, ttlMs: number): string {
  const body = `${value}.${Date.now() + ttlMs}`;
  return `${body}.${createHmac("sha256", appKey()).update(body).digest("base64url")}`;
}

export function verifyValue(token: string | undefined): string | null {
  const [value, expires, mac] = (token ?? "").split(".");
  if (!value || !expires || !mac) return null;
  const expected = createHmac("sha256", appKey()).update(`${value}.${expires}`).digest("base64url");
  return safeEqual(mac, expected) && Number(expires) > Date.now() ? value : null;
}
