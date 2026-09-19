import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";
process.env.APP_URL = "https://panel.example.com";

let dbm: typeof import("../src/db");
let github: typeof import("../src/lib/github");
let engine: typeof import("../src/platform/engine");
let agent: import("../agent/src/agent").Agent;
let clientId: string, userId: string, appId: string;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const calls: { method: string; url: string; body: string; auth: string }[] = [];
const visibleInstallations = [42];
let coveredRepos = ["acme/shop"];
const fake = (async (url: string, init: RequestInit = {}) => {
  const h = (init.headers ?? {}) as Record<string, string>;
  calls.push({ method: init.method ?? "GET", url, body: String(init.body ?? ""), auth: h.Authorization ?? "" });
  const ok = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (url === "https://github.com/login/oauth/access_token") return ok(JSON.parse(String(init.body)).code === "good-code" ? { access_token: "ghu_user" } : { error: "bad_verification_code" });
  if (url.includes("/user/installations")) return ok({ installations: visibleInstallations.map((id) => ({ id })) });
  if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) return coveredRepos.includes(`acme/${JSON.parse(String(init.body)).repositories[0]}`) ? ok({ token: "ghs_install" }, 201) : ok({ message: "There is at least one repository that does not exist or is not accessible" }, 422);
  if (/\/repos\/acme\/shop\/statuses\//.test(url)) return ok({}, 201);
  return ok({ message: "Not Found" }, 404);
}) as unknown as typeof fetch;

async function drain() {
  for (let i = 0; i < 20; i++) {
    const { started } = await agent.tick();
    await Promise.all(started);
    if (!started.length) return;
  }
}

before(async () => {
  dbm = await import("../src/db");
  github = await import("../src/lib/github");
  engine = await import("../src/platform/engine");
  github.setGithubHttpForTests(fake);
  const { updateSettings } = await import("../src/lib/settings");
  await updateSettings("github", { enabled: true, appId: "123456", slug: "aster-deploy", clientId: "Iv1.abc", clientSecret: "cs", privateKey, webhookSecret: "hook-secret" });
  const db = await dbm.getDb();
  [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "gh@example.test", passwordHash: "x" }).returning();
  userId = clientId;
  // A simulated node with a real agent loop, as in the platform tests.
  const { randomToken, sha256 } = await import("../src/lib/crypto");
  const token = randomToken(32);
  const [node] = await db.insert(dbm.schema.nodes).values({ name: "gh-node", baseDomain: "n.example.test", tokenHash: sha256(token), lastSeenAt: new Date(), status: "online" }).returning();
  const { Agent, loadPublicKey } = await import("../agent/src/agent");
  const { SimulatedDriver } = await import("../agent/src/simulated");
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  agent = new Agent({
    nodeId: node.id,
    publicKey: loadPublicKey((await engine.signingKeys()).publicKey),
    driver: new SimulatedDriver(mkdtempSync(path.join(os.tmpdir(), "gh-")), 0),
    transport: {
      poll: async (req) => {
        await engine.heartbeat(node.id, req);
        return { jobs: await engine.claimJobs(node.id, req.capacity), pollIntervalMs: 0 };
      },
      report: async (jobId, report) => void (await engine.reportJob(node.id, jobId, report)),
    },
    dataDir: os.tmpdir(),
    onError: () => {},
  });
  appId = await engine.createWorkload({ clientId, type: "app", name: "Shop", config: { repoUrl: "https://github.com/acme/shop.git", branch: "main", port: 3000 } });
  await drain();
});

const workload = async (id: string) => (await (await dbm.getDb()).select().from(dbm.schema.workloads).where(eq(dbm.schema.workloads.id, id)))[0];

test("repository URLs, the app JWT and webhook signatures", async () => {
  assert.equal(github.githubRepoOf("https://github.com/Acme/shop.git"), "Acme/shop");
  assert.equal(github.githubRepoOf("https://github.com/acme/shop/"), "acme/shop");
  for (const bad of ["https://gitlab.com/acme/shop", "https://github.com/acme", "https://github.com/acme/shop/tree/main", "https://github.com/../x", "http://github.com/acme/shop", "https://github.com.evil.io/acme/shop"]) assert.equal(github.githubRepoOf(bad), null, bad);

  const jwt = github.appJwt("123456", privateKey, new Date("2026-01-01T00:00:00Z"));
  const [h, p, sig] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.deepEqual([claims.iss, claims.exp - claims.iat <= 600], ["123456", true]);

  const body = '{"ref":"refs/heads/main"}';
  const good = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
  assert.equal(await github.verifyGithubSignature(body, good), true);
  for (const bad of [null, "", "sha1=abc", good.replace(/.$/, "0"), `sha256=${createHmac("sha256", "other").update(body).digest("hex")}`]) assert.equal(await github.verifyGithubSignature(body, bad), false);
  assert.equal(await github.verifyGithubSignature(`${body} `, good), false);
});

test("connecting: the installation id from the URL is only trusted if the GitHub user can see it and it covers the repository", async () => {
  const url = await github.installUrl(appId, userId);
  assert.ok(url.startsWith("https://github.com/apps/aster-deploy/installations/new?state="));
  const state = decodeURIComponent(url.split("state=")[1]);
  assert.equal(github.stateWorkload(state, userId), appId);
  assert.equal(github.stateWorkload(state, "someone-else"), null);
  assert.equal(github.stateWorkload(`${state}x`, userId), null);

  const attempt = (o: Partial<{ state: string; installationId: string; code: string; userId: string }>) => github.connectInstallation({ state, installationId: "42", code: "good-code", userId, ...o });
  await assert.rejects(attempt({ userId: "someone-else" }), /expired/);
  await assert.rejects(attempt({ code: "" }), /did not confirm who/);
  await assert.rejects(attempt({ code: "stolen" }), /did not confirm who/);
  await assert.rejects(attempt({ installationId: "99" }), /no access to that installation/, "somebody else's installation id pasted into the URL");
  await assert.rejects(attempt({ installationId: "42/../1" }), /did not confirm|Invalid/);
  coveredRepos = [];
  await assert.rejects(attempt({}), /not installed on acme\/shop/);
  assert.equal((await workload(appId)).githubInstallationId, "", "nothing is saved by a refused attempt");

  coveredRepos = ["acme/shop"];
  calls.length = 0;
  assert.equal(await attempt({}), appId);
  assert.deepEqual([(await workload(appId)).githubInstallationId, (await workload(appId)).githubRepo], ["42", "acme/shop"]);
  const mint = calls.find((c) => c.url.endsWith("/app/installations/42/access_tokens"))!;
  assert.deepEqual(JSON.parse(mint.body), { repositories: ["shop"], permissions: { contents: "read", statuses: "write" } }, "least privilege, one repository");
});

test("a connected app clones with a fresh installation token and reports the result on the commit", async () => {
  const db = await dbm.getDb();
  const { decryptJson } = await import("../src/lib/crypto");
  assert.deepEqual((await github.workloadsForPush("acme/shop", "42")).map((w) => w.id), [appId]);
  assert.deepEqual(await github.workloadsForPush("acme/shop", "7"), [], "a push signed for another installation does not deploy");

  calls.length = 0;
  const { id: deploymentId } = await engine.handlePush(appId, engine.parsePush({ ref: "refs/heads/main" }));
  const [job] = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.deploymentId, deploymentId!));
  assert.equal(decryptJson<{ spec: { source: { accessToken: string } } }>(job.payload, {} as never).spec.source.accessToken, "ghs_install");
  await drain();
  const status = calls.find((c) => /\/statuses\/[0-9a-f]{40}$/.test(c.url))!;
  assert.deepEqual([status.auth, JSON.parse(status.body).state, JSON.parse(status.body).context, JSON.parse(status.body).target_url], ["Bearer ghs_install", "success", "asterpanel/deploy", `https://panel.example.com/client/workloads/${appId}/deployments`]);

  await github.forgetInstallation("42");
  assert.equal((await workload(appId)).githubInstallationId, "");
  calls.length = 0;
  await engine.deployWorkload(appId, "manual");
  await drain();
  assert.equal(calls.length, 0, "disconnected: GitHub is not contacted any more");
});
