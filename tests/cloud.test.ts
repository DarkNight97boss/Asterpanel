import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let cloud: typeof import("../src/lib/cloud");
let settings: typeof import("../src/lib/settings");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const serviceAccountJson = JSON.stringify({ client_email: "aster@proj.iam.gserviceaccount.com", private_key: privateKey, project_id: "aster-proj-1" });

const calls: { method: string; url: string; body: string; headers: Record<string, string> }[] = [];
let gone = false;
const fake = (async (url: string, init: RequestInit = {}) => {
  calls.push({ method: init.method ?? "GET", url, body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (url.startsWith("https://api.hetzner.cloud")) {
    if (gone) return json({ error: { code: "not_found", message: "server not found" } }, 404);
    if (init.method === "POST") return JSON.parse(String(init.body)).server_type === "nope" ? json({ error: { message: "server type nope not found" } }, 422) : json({ server: { id: 4711, status: "initializing", public_net: { ipv4: { ip: "" } } } });
    if (init.method === "DELETE") return json({});
    return json({ server: { id: 4711, status: "running", public_net: { ipv4: { ip: "203.0.113.7" } } }, servers: [] });
  }
  if (url.includes("amazonaws.com")) {
    const action = new URLSearchParams(String(init.body)).get("Action");
    if (action === "RunInstances") return new Response("<RunInstancesResponse><instancesSet><item><instanceId>i-0abc123def</instanceId></item></instancesSet></RunInstancesResponse>");
    if (action === "DescribeInstances") return new Response("<r><instanceState><code>16</code><name>running</name></instanceState><ipAddress>198.51.100.9</ipAddress></r>");
    return new Response("<ok/>");
  }
  if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "ya29.test" });
  if (url.startsWith("https://compute.googleapis.com")) return init.method === "GET" && url.includes("/instances/") ? json({ name: "gcp-node-01", status: "RUNNING", networkInterfaces: [{ accessConfigs: [{ natIP: "192.0.2.44" }] }] }) : json({});
  return json({}, 404);
}) as unknown as typeof fetch;

before(async () => {
  dbm = await import("../src/db");
  cloud = await import("../src/lib/cloud");
  settings = await import("../src/lib/settings");
  cloud.setCloudHttpForTests(fake);
  await settings.updateSettings("cloud", { acmeEmail: "ops@example.test", accounts: { hetzner: { enabled: "1", token: "hz-token" }, aws: { enabled: "1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", securityGroupId: "sg-0123", subnetId: "" }, gcp: { enabled: "", serviceAccountJson } } });
});

const ORIGIN = "https://panel.example.com";
const nodeBy = async (name: string) => (await (await dbm.getDb()).select().from(dbm.schema.nodes).where(eq(dbm.schema.nodes.name, name)))[0];

test("AWS Signature V4 matches Amazon's published test vector", async () => {
  const { signV4 } = await import("../src/modules/cloud/aws");
  const s = signV4({ method: "GET", host: "iam.amazonaws.com", path: "/", query: { Version: "2010-05-08", Action: "ListUsers" }, headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" }, body: "", region: "us-east-1", service: "iam", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", now: new Date("2015-08-30T12:36:00Z") });
  assert.equal(s.canonicalQuery, "Action=ListUsers&Version=2010-05-08");
  assert.equal(s.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
});

test("Google: the service-account JWT verifies with the account's public key, and bad key files are refused", async () => {
  const { serviceAccountJwt, parseServiceAccount } = await import("../src/modules/cloud/gcp");
  const jwt = serviceAccountJwt(parseServiceAccount(serviceAccountJson), new Date("2026-01-01T00:00:00Z"));
  const [h, p, sig] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.deepEqual([claims.iss, claims.aud, claims.exp - claims.iat], ["aster@proj.iam.gserviceaccount.com", "https://oauth2.googleapis.com/token", 600]);
  for (const bad of ["nope", "{}", JSON.stringify({ client_email: "x", private_key: "PRIVATE KEY", project_id: "../etc" })]) assert.throws(() => parseServiceAccount(bad), /service account key/);
});

test("the boot script only ever contains validated values", () => {
  const ok = cloud.bootScript({ origin: ORIGIN, token: "0b1c-uuid.tok_en-1", publicKey: "MCowBQYDK2VwAyEA9blO+/=", acmeEmail: "ops@example.test" });
  assert.ok(ok.startsWith("#!/bin/bash\n[ -f /etc/aster-agent.env ] && exit 0") && ok.includes(`curl -fsSL '${ORIGIN}/agent/install.sh' | ASTER_URL='${ORIGIN}' ASTER_TOKEN='0b1c-uuid.tok_en-1'`));
  for (const bad of [{ origin: "http://panel.example.com" }, { origin: "https://localhost" }, { token: "a'; rm -rf / #" }, { publicKey: "$(id)" }, { acmeEmail: "a'b@x.it" }])
    assert.throws(() => cloud.bootScript({ origin: ORIGIN, token: "t", publicKey: "k", acmeEmail: "", ...bad }), cloud.CloudNodeError, JSON.stringify(bad));
});

test("Hetzner: a node is created with its server, gets its address later, and the server dies with the node", async () => {
  const db = await dbm.getDb();
  assert.deepEqual((await cloud.enabledCloudProviders()).map((p) => p.id), ["hetzner", "aws"], "only what the administrator switched on");
  await assert.rejects(cloud.createCloudNode({ provider: "gcp", name: "x-1", region: "europe-west8-a", size: "e2-small", baseDomain: "", maxWorkloads: 0, origin: ORIGIN }), /not enabled/);
  await assert.rejects(cloud.createCloudNode({ provider: "hetzner", name: "Bad Name", region: "fsn1", size: "cx22", baseDomain: "", maxWorkloads: 0, origin: ORIGIN }), /lower-case/);
  await assert.rejects(cloud.createCloudNode({ provider: "hetzner", name: "hz-fail", region: "fsn1", size: "nope", baseDomain: "", maxWorkloads: 0, origin: ORIGIN }), /server type nope not found/);
  assert.equal(await nodeBy("hz-fail"), undefined, "a refused creation leaves no orphan node");

  calls.length = 0;
  const id = await cloud.createCloudNode({ provider: "hetzner", name: "hz-node-01", region: "fsn1", size: "cx22", baseDomain: "n1.example.cloud", maxWorkloads: 20, origin: ORIGIN });
  const req = JSON.parse(calls[0].body);
  assert.deepEqual([calls[0].headers.Authorization, req.name, req.server_type, req.location, req.image], ["Bearer hz-token", "hz-node-01", "cx22", "fsn1", "ubuntu-24.04"]);
  assert.ok(req.user_data.includes(`ASTER_TOKEN='${id}.`) && req.user_data.includes("ASTER_ACME_EMAIL='ops@example.test'"));
  let n = await nodeBy("hz-node-01");
  assert.deepEqual([n.provider, n.providerServerId, n.providerSize, n.publicIp, n.status], ["hetzner", "4711", "cx22", "", "pending"]);
  assert.ok(!req.user_data.includes(n.tokenHash), "the machine gets the token, the database only its hash");
  await assert.rejects(cloud.createCloudNode({ provider: "hetzner", name: "hz-node-01", region: "fsn1", size: "cx22", baseDomain: "", maxWorkloads: 0, origin: ORIGIN }), /already exists/);

  assert.equal(await cloud.syncCloudNodes(), 1);
  assert.equal((await nodeBy("hz-node-01")).publicIp, "203.0.113.7");
  assert.equal(await cloud.syncCloudNodes(), 0);

  await cloud.destroyCloudServer(id);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/servers/4711")));
  n = await nodeBy("hz-node-01");
  assert.equal(n.providerServerId, "");
  gone = true;
  await db.update(dbm.schema.nodes).set({ providerServerId: "4711" }).where(eq(dbm.schema.nodes.id, id));
  await cloud.destroyCloudServer(id); // already deleted at the provider: not an error
  gone = false;
});

test("AWS and Google requests carry what each API expects", async () => {
  calls.length = 0;
  await cloud.createCloudNode({ provider: "aws", name: "aws-node-01", region: "eu-south-1", size: "t3.medium", baseDomain: "", maxWorkloads: 0, origin: ORIGIN });
  const run = calls.find((c) => c.url === "https://ec2.eu-south-1.amazonaws.com/")!;
  const p = new URLSearchParams(run.body);
  assert.deepEqual([p.get("Action"), p.get("InstanceType"), p.get("ImageId")?.startsWith("resolve:ssm:/aws/service/canonical/ubuntu"), p.get("NetworkInterface.1.SecurityGroupId.1"), p.get("MetadataOptions.HttpTokens"), p.get("ClientToken")], ["RunInstances", "t3.medium", true, "sg-0123", "required", "aster-aws-node-01"]);
  assert.ok(Buffer.from(p.get("UserData")!, "base64").toString().startsWith("#!/bin/bash"));
  assert.match(run.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-south-1\/ec2\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal((await nodeBy("aws-node-01")).providerServerId, "i-0abc123def");
  await cloud.syncCloudNodes();
  assert.equal((await nodeBy("aws-node-01")).publicIp, "198.51.100.9");
  await assert.rejects(cloud.createCloudNode({ provider: "aws", name: "aws-bad", region: "evil.example.com/x", size: "t3.small", baseDomain: "", maxWorkloads: 0, origin: ORIGIN }), /Invalid AWS region|region/);

  const s = await settings.getSettings("cloud");
  await settings.updateSettings("cloud", { ...s, accounts: { ...s.accounts, gcp: { enabled: "1", serviceAccountJson } } });
  calls.length = 0;
  await cloud.createCloudNode({ provider: "gcp", name: "gcp-node-01", region: "europe-west8-a", size: "e2-medium", baseDomain: "", maxWorkloads: 0, origin: ORIGIN });
  const insert = calls.find((c) => c.method === "POST" && c.url.startsWith("https://compute.googleapis.com"))!;
  assert.equal(insert.url, "https://compute.googleapis.com/compute/v1/projects/aster-proj-1/zones/europe-west8-a/instances");
  const body = JSON.parse(insert.body);
  assert.deepEqual([insert.headers.Authorization, body.machineType, body.metadata.items[0].key, body.tags.items, body.disks[0].initializeParams.sourceImage.includes("ubuntu-2404")], ["Bearer ya29.test", "zones/europe-west8-a/machineTypes/e2-medium", "startup-script", ["http-server", "https-server"], true]);
  await cloud.syncCloudNodes();
  assert.equal((await nodeBy("gcp-node-01")).publicIp, "192.0.2.44");
});
