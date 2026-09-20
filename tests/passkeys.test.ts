import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let passkeys: typeof import("../src/lib/passkeys");
let alice: { id: string; email: string; firstName: string; lastName: string };
let bobId: string;

const site = { origin: "https://panel.example.test", name: "Aster" };
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

// Just enough CBOR for an attestation object and a COSE key.
const head = (major: number, n: number) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
const cInt = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));
const cBytes = (b: Uint8Array) => Buffer.concat([head(2, b.length), b]);
const cText = (s: string) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cMap = (pairs: [Buffer, Buffer][]) => Buffer.concat([head(5, pairs.length), ...pairs.flat()]);

/** A software authenticator: one ES256 credential bound to one relying party. */
class Authenticator {
  readonly credentialId = randomBytes(32);
  private readonly key: KeyObject;
  private readonly cose: Buffer;
  counter = 0;
  constructor(readonly rpId: string, readonly userVerified = true) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cose = cMap([[cInt(1), cInt(2)], [cInt(3), cInt(-7)], [cInt(-1), cInt(1)], [cInt(-2), cBytes(Buffer.from(jwk.x!, "base64url"))], [cInt(-3), cBytes(Buffer.from(jwk.y!, "base64url"))]]);
  }
  private authData(attested: boolean) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const flags = 0x01 | (this.userVerified ? 0x04 : 0) | (attested ? 0x40 : 0);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), counter, ...(attested ? [Buffer.alloc(16), len, this.credentialId, this.cose] : [])]);
  }
  private clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  create(challenge: string, origin: string) {
    const attestationObject = cMap([[cText("fmt"), cText("none")], [cText("attStmt"), cMap([])], [cText("authData"), cBytes(this.authData(true))]]);
    return { id: b64(this.credentialId), rawId: b64(this.credentialId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64(this.clientData("webauthn.create", challenge, origin)), attestationObject: b64(attestationObject), transports: ["internal"] } } as never;
  }
  get(challenge: string, origin: string) {
    const clientDataJSON = this.clientData("webauthn.get", challenge, origin);
    const authData = this.authData(false);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.key);
    return { id: b64(this.credentialId), rawId: b64(this.credentialId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authData), signature: b64(signature) } } as never;
  }
}

before(async () => {
  dbm = await import("../src/db");
  passkeys = await import("../src/lib/passkeys");
  const db = await dbm.getDb();
  const [a, b] = await db.insert(dbm.schema.users).values([{ email: "alice@example.test", passwordHash: "x", firstName: "Alice", lastName: "Rossi" }, { email: "bob@example.test", passwordHash: "x" }]).returning();
  alice = a;
  bobId = b.id;
});

const device = new Authenticator("panel.example.test");

test("registration: discoverable, user-verified, bound to this site and this challenge", async () => {
  const options = await passkeys.registrationOptions(alice, site);
  assert.equal(options.rp.id, "panel.example.test");
  assert.deepEqual([options.authenticatorSelection?.residentKey, options.authenticatorSelection?.userVerification, options.attestation], ["required", "required", "none"]);

  await assert.rejects(passkeys.finishRegistration(alice.id, device.create("another-challenge", site.origin), options.challenge, site, "x"), /could not be verified/);
  await assert.rejects(passkeys.finishRegistration(alice.id, device.create(options.challenge, "https://evil.example"), options.challenge, site, "x"), /could not be verified/);
  await assert.rejects(passkeys.finishRegistration(alice.id, new Authenticator("evil.example").create(options.challenge, site.origin), options.challenge, site, "x"), /could not be verified/);
  await assert.rejects(passkeys.finishRegistration(alice.id, new Authenticator("panel.example.test", false).create(options.challenge, site.origin), options.challenge, site, "x"), /could not be verified/, "no fingerprint or PIN, no passkey");

  await passkeys.finishRegistration(alice.id, device.create(options.challenge, site.origin), options.challenge, site, "  MacBook  ");
  assert.deepEqual((await passkeys.listPasskeys(alice.id)).map((p) => p.name), ["MacBook"]);
  await assert.rejects(passkeys.finishRegistration(bobId, device.create(options.challenge, site.origin), options.challenge, site, "stolen"), /already registered/);
  // The next ceremony tells the browser not to offer this authenticator again.
  assert.deepEqual((await passkeys.registrationOptions(alice, site)).excludeCredentials?.map((c) => c.id), [b64(device.credentialId)]);
});

test("sign-in: the signature decides who it is; wrong challenge, origin, key or a replayed counter are refused alike", async () => {
  const options = await passkeys.loginOptions(site);
  assert.equal(options.userVerification, "required");
  assert.equal(options.allowCredentials, undefined);

  await assert.rejects(passkeys.finishLogin(device.get("stale", site.origin), options.challenge, site), /not accepted/);
  await assert.rejects(passkeys.finishLogin(device.get(options.challenge, "https://evil.example"), options.challenge, site), /not accepted/);
  await assert.rejects(passkeys.finishLogin(new Authenticator("panel.example.test").get(options.challenge, site.origin), options.challenge, site), /not accepted/, "unknown credential");
  // Somebody who knows the credential id but not the private key.
  const forged = new Authenticator("panel.example.test");
  Object.assign(forged, { credentialId: device.credentialId });
  await assert.rejects(passkeys.finishLogin(forged.get(options.challenge, site.origin), options.challenge, site), /not accepted/);

  assert.equal(await passkeys.finishLogin(device.get(options.challenge, site.origin), options.challenge, site), alice.id);
  const db = await dbm.getDb();
  const [row] = await db.select().from(dbm.schema.passkeys).where(eq(dbm.schema.passkeys.userId, alice.id));
  assert.equal(row.counter, device.counter);
  assert.ok(row.lastUsedAt);
  // A cloned authenticator lags behind on the signature counter.
  device.counter -= 2;
  await assert.rejects(passkeys.finishLogin(device.get(options.challenge, site.origin), options.challenge, site), /not accepted/);
  device.counter += 5;
});

test("suspended accounts stay out; a passkey is removed only by its owner", async () => {
  const db = await dbm.getDb();
  const { challenge } = await passkeys.loginOptions(site);
  await db.update(dbm.schema.users).set({ status: "suspended" }).where(eq(dbm.schema.users.id, alice.id));
  await assert.rejects(passkeys.finishLogin(device.get(challenge, site.origin), challenge, site), /not active/);
  await db.update(dbm.schema.users).set({ status: "active" }).where(eq(dbm.schema.users.id, alice.id));

  const [mine] = await passkeys.listPasskeys(alice.id);
  await passkeys.removePasskey(bobId, mine.id);
  assert.equal((await passkeys.listPasskeys(alice.id)).length, 1);
  await passkeys.removePasskey(alice.id, mine.id);
  await assert.rejects(passkeys.finishLogin(device.get(challenge, site.origin), challenge, site), /not accepted/);
});
