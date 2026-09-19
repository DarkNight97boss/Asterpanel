import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let totp: typeof import("../src/lib/totp");
let userId: string;

before(async () => {
  dbm = await import("../src/db");
  totp = await import("../src/lib/totp");
  const db = await dbm.getDb();
  [{ id: userId }] = await db.insert(dbm.schema.users).values({ email: "2fa@example.test", passwordHash: "x" }).returning();
});

test("TOTP matches the RFC 6238 test vector", () => {
  // Secret "12345678901234567890", T = 59 s → 94287082 (8 digits) → last 6 = 287082
  assert.equal(totp.totpAt(totp.base32(Buffer.from("12345678901234567890")), Math.floor(59 / 30)), "287082");
});

test("enrolment needs a valid code; codes cannot be replayed; recovery codes burn", async () => {
  const db = await dbm.getDb();
  const secret = await totp.beginEnrolment(userId);
  assert.ok(!(await db.select().from(dbm.schema.users).where(eq(dbm.schema.users.id, userId)))[0].totpSecret.includes(secret), "secret is encrypted at rest");
  assert.equal(await totp.verifySecondFactor(userId, "000000"), false, "not enabled yet: nothing verifies");
  assert.equal(await totp.confirmEnrolment(userId, "000000"), null);

  const step = Math.floor(Date.now() / 30_000);
  const codes = await totp.confirmEnrolment(userId, totp.totpAt(secret, step));
  assert.equal(codes?.length, 8);
  assert.equal(await totp.pendingSecret(userId), null, "enrolment is over");

  assert.equal(await totp.verifySecondFactor(userId, totp.totpAt(secret, step)), false, "the enrolment code cannot sign in again");
  assert.equal(await totp.verifySecondFactor(userId, totp.totpAt(secret, step + 1)), true, "clock drift of one step is accepted");
  assert.equal(await totp.verifySecondFactor(userId, totp.totpAt(secret, step + 1)), false, "replay refused");
  assert.equal(await totp.verifySecondFactor(userId, totp.totpAt(secret, step - 5)), false, "old code refused");

  assert.equal(await totp.verifySecondFactor(userId, codes![0].toUpperCase()), true, "recovery code, case-insensitive");
  assert.equal(await totp.verifySecondFactor(userId, codes![0]), false, "…only once");

  await totp.disableTotp(userId);
  assert.equal(await totp.verifySecondFactor(userId, codes![1]), false);
});

test("signed values expire and cannot be forged", async () => {
  const { signValue, verifyValue } = await import("../src/lib/crypto");
  const token = signValue("user-1", 60_000);
  assert.equal(verifyValue(token), "user-1");
  assert.equal(verifyValue(token.replace("user-1", "user-2")), null);
  assert.equal(verifyValue(signValue("user-1", -1)), null);
  assert.equal(verifyValue(undefined), null);
});
