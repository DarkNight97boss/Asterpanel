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
let reservedCount = 0;
const gcpAddresses = new Map<string, string>();
const fake = (async (url: string, init: RequestInit = {}) => {
  calls.push({ method: init.method ?? "GET", url, body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (url.startsWith("https://api.hetzner.cloud")) {
    if (url.endsWith("/datacenters")) return json({ datacenters: [{ name: "nbg1-dc3", location: { name: "nbg1" } }, { name: "fsn1-dc14", location: { name: "fsn1" } }] });
    if (url.endsWith("/primary_ips") && init.method === "POST") return json({ primary_ip: { id: 9000 + ++reservedCount, ip: `198.51.100.${10 + reservedCount}` } });
    if (/\/primary_ips\/\d+$/.test(url)) return init.method === "DELETE" ? json({}) : json({ primary_ip: { datacenter: { name: "fsn1-dc14" } } });
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
  if (/compute\.googleapis\.com.*\/regions\/[a-z0-9-]+\/addresses/.test(url)) {
    if (init.method === "POST") {
      const b = JSON.parse(String(init.body));
      gcpAddresses.set(b.name, b.address ?? "34.0.0.99");
      return json({});
    }
    const name = url.split("/").at(-1)!;
    if (init.method === "DELETE") return gcpAddresses.delete(name) ? json({}) : json({ error: { message: "not found" } }, 404);
    return gcpAddresses.has(name) ? json({ address: gcpAddresses.get(name), status: "RESERVED" }) : json({ error: { message: "not found" } }, 404);
  }
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

test("automatic mode: no room means a new cloud server, shared by orders arriving together, within the ceiling", async () => {
  const db = await dbm.getDb();
  const engine = await import("../src/platform/engine");
  const [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "auto@example.test", passwordHash: "x" }).returning();
  const s = await settings.getSettings("cloud");
  const auto = { enabled: false, provider: "hetzner", region: "fsn1", size: "cx32", maxNodes: 2, workloadsPerNode: 2, minFreeSlots: 0, baseDomainTemplate: "{name}.nodes.example.com", removeEmptyAfterHours: 1 };
  await settings.updateSettings("cloud", { ...s, autoscale: auto });
  await db.update(dbm.schema.nodes).set({ status: "disabled" });
  await assert.rejects(engine.createWorkload({ clientId, type: "database", name: "Manual", config: { engine: "redis" } }), /No server is available/, "manual mode: orders wait for the administrator");

  await settings.updateSettings("cloud", { ...s, autoscale: { ...auto, enabled: true } });
  process.env.APP_URL = ORIGIN;
  calls.length = 0;
  const [a, b] = await Promise.all([engine.createWorkload({ clientId, type: "database", name: "One", config: { engine: "redis" } }), engine.createWorkload({ clientId, type: "database", name: "Two", config: { engine: "redis" } })]);
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.endsWith("/servers")).length, 1, "two simultaneous orders, one new server");
  const wa = (await db.select().from(dbm.schema.workloads).where(eq(dbm.schema.workloads.id, a)))[0];
  const wb = (await db.select().from(dbm.schema.workloads).where(eq(dbm.schema.workloads.id, b)))[0];
  assert.equal(wa.nodeId, wb.nodeId);
  const [node] = await db.select().from(dbm.schema.nodes).where(eq(dbm.schema.nodes.id, wa.nodeId));
  assert.deepEqual([node.autoscaled, node.provider, node.providerSize, node.maxWorkloads, node.baseDomain, wa.status], [true, "hetzner", "cx32", 2, `${node.name}.nodes.example.com`, "creating"]);

  const c = await engine.createWorkload({ clientId, type: "database", name: "Three", config: { engine: "redis" } });
  assert.notEqual((await db.select().from(dbm.schema.workloads).where(eq(dbm.schema.workloads.id, c)))[0].nodeId, node.id, "the first server is full: a second one");
  await engine.createWorkload({ clientId, type: "database", name: "Four", config: { engine: "redis" } });
  await assert.rejects(engine.createWorkload({ clientId, type: "database", name: "Five", config: { engine: "redis" } }), /No server is available/, "the ceiling on servers holds");
  await assert.rejects(engine.createWorkload({ clientId, type: "database", name: "Elsewhere", region: "us-east", config: { engine: "redis" } }), /in this region/);

  // The wildcard record appears by itself when the parent zone is hosted here.
  await db.insert(dbm.schema.dnsZones).values({ clientId, name: "nodes.example.com" });
  await db.update(dbm.schema.nodes).set({ publicIp: "" }).where(eq(dbm.schema.nodes.id, node.id));
  await cloud.syncCloudNodes();
  const records = await db.select().from(dbm.schema.dnsRecords);
  assert.deepEqual(records.filter((r) => r.name.endsWith(node.name)).map((r) => [r.name, r.type, r.value]).sort(), [[`*.${node.name}`, "A", "203.0.113.7"], [node.name, "A", "203.0.113.7"]]);
});

test("automatic mode keeps the reserve asked for and retires servers that stayed empty, never below the reserve", async () => {
  const db = await dbm.getDb();
  const s = await settings.getSettings("cloud");
  await db.delete(dbm.schema.workloads);
  await db.update(dbm.schema.nodes).set({ lastSeenAt: new Date(), status: "online" }).where(eq(dbm.schema.nodes.autoscaled, true));
  const now = new Date();
  assert.deepEqual(await cloud.maintainCapacity(now, ORIGIN), { created: 0, removed: 0 }, "first run only notes that they are empty");
  const later = new Date(now.getTime() + 2 * 3_600_000);
  await db.update(dbm.schema.nodes).set({ lastSeenAt: later }).where(eq(dbm.schema.nodes.autoscaled, true));

  await settings.updateSettings("cloud", { ...s, autoscale: { ...s.autoscale, minFreeSlots: 3 } });
  assert.deepEqual(await cloud.maintainCapacity(later, ORIGIN), { created: 0, removed: 0 }, "4 free places, 3 to keep: removing a server of 2 would break the reserve");
  await settings.updateSettings("cloud", { ...s, autoscale: { ...s.autoscale, minFreeSlots: 2 } });
  calls.length = 0;
  assert.deepEqual(await cloud.maintainCapacity(later, ORIGIN), { created: 0, removed: 1 });
  assert.ok(calls.some((c) => c.method === "DELETE"));
  assert.equal((await db.select().from(dbm.schema.nodes).where(eq(dbm.schema.nodes.autoscaled, true))).length, 1);

  await settings.updateSettings("cloud", { ...s, autoscale: { ...s.autoscale, minFreeSlots: 4, removeEmptyAfterHours: 0 } });
  assert.deepEqual(await cloud.maintainCapacity(later, ORIGIN), { created: 1, removed: 0 }, "short of the reserve: one more server");
  await settings.updateSettings("cloud", { ...s, autoscale: { ...s.autoscale, enabled: false } });
  assert.deepEqual(await cloud.maintainCapacity(later, ORIGIN), { created: 0, removed: 0 });
});

test("IPv4 blocks: boundaries, capacity, public space only", async () => {
  const ipam = await import("../src/lib/ipam");
  assert.deepEqual([ipam.nextFreeAddress("203.0.113.0/30", []), ipam.nextFreeAddress("203.0.113.0/30", ["203.0.113.1"]), ipam.nextFreeAddress("203.0.113.0/30", ["203.0.113.1", "203.0.113.2"])], ["203.0.113.1", "203.0.113.2", null], "network and broadcast are never leased");
  assert.deepEqual([ipam.blockCapacity("203.0.113.0/28"), ipam.blockCapacity("203.0.113.8/31"), ipam.blockCapacity("203.0.113.9/32")], [14, 2, 1]);
  assert.equal(ipam.nextFreeAddress("198.51.100.255/32", []), "198.51.100.255");
  for (const bad of ["203.0.113.5/28", "203.0.113.0/8", "203.0.113.0/33", "300.0.0.0/24", "203.0.113.0", "::1/64"]) assert.equal(ipam.parseCidr(bad), null, bad);
  for (const priv of ["10.0.0.0/24", "192.168.1.0/24", "172.16.0.0/16", "100.64.0.0/24", "127.0.0.0/24", "169.254.0.0/24", "224.0.0.0/24"]) assert.equal(ipam.isPublicCidr(priv), false, priv);
  assert.equal(ipam.isPublicCidr("203.0.113.0/28"), true);
  assert.deepEqual([ipam.cidrContains("203.0.113.0/28", "203.0.113.15"), ipam.cidrContains("203.0.113.0/28", "203.0.113.16")], [true, false]);
});

test("address pools: new servers lease by themselves, freed addresses are reused first, own blocks are handed out in order", async () => {
  const db = await dbm.getDb();
  const pools = await import("../src/lib/ip-pools");
  const s = await settings.getSettings("cloud");
  await settings.updateSettings("cloud", { ...s, autoscale: { ...s.autoscale, enabled: false }, accounts: { ...s.accounts, hetzner: { enabled: "1", token: "hz-token" }, gcp: { enabled: "1", serviceAccountJson } } });

  await assert.rejects(pools.createIpPool({ name: "x", provider: "aws", region: "eu-south-1", mode: "reserved", cidr: "", autoLease: true }), /cannot reserve/);
  await assert.rejects(pools.createIpPool({ name: "x", provider: "hetzner", region: "fsn1", mode: "block", cidr: "203.0.113.0/28", autoLease: true }), /cannot host your own block/);
  await assert.rejects(pools.createIpPool({ name: "x", provider: "gcp", region: "europe-west8", mode: "block", cidr: "10.0.0.0/24", autoLease: true }), /public IPv4 block/);
  const hz = await pools.createIpPool({ name: "Falkenstein", provider: "hetzner", region: "fsn1", mode: "reserved", cidr: "", autoLease: true });
  await pools.createIpPool({ name: "Milan BYOIP", provider: "gcp", region: "europe-west8", mode: "block", cidr: "203.0.113.0/29", autoLease: true });
  await assert.rejects(pools.createIpPool({ name: "Overlap", provider: "gcp", region: "europe-west8", mode: "block", cidr: "203.0.113.4/30", autoLease: true }), /overlaps the pool/);

  // Hetzner: a primary IP is reserved, and the server is created in its datacenter with it.
  calls.length = 0;
  const n1 = await cloud.createCloudNode({ provider: "hetzner", name: "pool-hz-1", region: "fsn1", size: "cx22", baseDomain: "", maxWorkloads: 0, origin: ORIGIN });
  const create = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/servers"))!.body);
  assert.deepEqual([create.datacenter, create.location, typeof create.public_net.ipv4], ["fsn1-dc14", undefined, "number"]);
  const first = (await nodeBy("pool-hz-1")).publicIp;
  assert.match(first, /^198\.51\.100\.\d+$/, "known right away: no waiting for the provider");

  // The server goes away: the address stays reserved and is the next one used.
  await cloud.destroyCloudServer(n1);
  await db.delete(dbm.schema.nodes).where(eq(dbm.schema.nodes.id, n1));
  const before = reservedCount;
  await cloud.createCloudNode({ provider: "hetzner", name: "pool-hz-2", region: "fsn1", size: "cx22", baseDomain: "", maxWorkloads: 0, origin: ORIGIN });
  assert.deepEqual([(await nodeBy("pool-hz-2")).publicIp, reservedCount], [first, before], "reused, nothing new reserved");
  await cloud.createCloudNode({ provider: "hetzner", name: "pool-hz-nbg", region: "nbg1", size: "cx22", baseDomain: "", maxWorkloads: 0, origin: ORIGIN });
  assert.equal(reservedCount, before, "another region is not covered by the pool");

  // Google: addresses come out of the company's block, in order, and go into the instance.
  calls.length = 0;
  await cloud.createCloudNode({ provider: "gcp", name: "pool-gcp-1", region: "europe-west8-a", size: "e2-small", baseDomain: "", maxWorkloads: 0, origin: ORIGIN });
  await cloud.createCloudNode({ provider: "gcp", name: "pool-gcp-2", region: "europe-west8-b", size: "e2-small", baseDomain: "", maxWorkloads: 0, origin: ORIGIN });
  assert.deepEqual([(await nodeBy("pool-gcp-1")).publicIp, (await nodeBy("pool-gcp-2")).publicIp], ["203.0.113.1", "203.0.113.2"]);
  const reserve = JSON.parse(calls.find((c) => c.method === "POST" && c.url.includes("/regions/europe-west8/addresses"))!.body);
  assert.deepEqual([reserve.address, reserve.addressType], ["203.0.113.1", "EXTERNAL"]);
  const insert = JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/zones/europe-west8-a/instances"))!.body);
  assert.equal(insert.networkInterfaces[0].accessConfigs[0].natIP, "203.0.113.1");

  // A creation that fails gives its address back to the pool.
  await assert.rejects(cloud.createCloudNode({ provider: "hetzner", name: "pool-hz-fail", region: "fsn1", size: "nope", baseDomain: "", maxWorkloads: 0, origin: ORIGIN }), /not found/);
  const usage = await pools.poolUsage();
  const hzUsage = usage.find((u) => u.pool.id === hz)!;
  assert.deepEqual([hzUsage.inUse, hzUsage.leases.length], [1, 2], "one leased, one free and still reserved");

  const freeLease = hzUsage.leases.find((l) => !l.lease.nodeId)!;
  const busyLease = hzUsage.leases.find((l) => l.lease.nodeId)!;
  await assert.rejects(pools.releaseAddress(busyLease.lease.id), /in use by a server/);
  await assert.rejects(pools.deleteIpPool(hz), /Release the pool/);
  await pools.releaseAddress(freeLease.lease.id);
  assert.ok(calls.some((c) => c.method === "DELETE" && /\/primary_ips\/\d+$/.test(c.url)));
});
