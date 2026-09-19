import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { eq, ne } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

import { Agent, loadPublicKey, type Transport } from "../agent/src/agent";
import { SimulatedDriver } from "../agent/src/simulated";
import type { SignedJob } from "../src/platform/protocol";

let dbm: typeof import("../src/db");
let engine: typeof import("../src/platform/engine");
let agent: Agent;
let nodeId: string;
let clientId: string;
const errors: string[] = [];
/** Lets a test tamper with what the agent receives. */
let intercept: (jobs: SignedJob[]) => SignedJob[] = (j) => j;

/** Polls until the queue is drained, like a node would over a few seconds. */
async function drain() {
  for (let i = 0; i < 20; i++) {
    const { started } = await agent.tick();
    await Promise.all(started);
    if (!started.length) return;
  }
  throw new Error("queue never drained");
}
const workload = async (id: string) => (await (await dbm.getDb()).query.workloads.findFirst({ where: eq(dbm.schema.workloads.id, id), with: { domains: true, backups: true, deployments: true } }))!;

before(async () => {
  dbm = await import("../src/db");
  engine = await import("../src/platform/engine");
  const { sha256 } = await import("../src/lib/crypto");
  const db = await dbm.getDb();
  [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "c@example.test", passwordHash: "x" }).returning();
  [{ id: nodeId }] = await db.insert(dbm.schema.nodes).values({ name: "node-1", region: "eu", baseDomain: "n1.aster.test", tokenHash: sha256("t") }).returning();

  const transport: Transport = {
    poll: async (req) => {
      await engine.heartbeat(nodeId, req);
      return { jobs: intercept(await engine.claimJobs(nodeId, req.capacity)), pollIntervalMs: 0 };
    },
    report: async (jobId, report) => void (await engine.reportJob(nodeId, jobId, report)),
  };
  agent = new Agent({
    nodeId,
    publicKey: loadPublicKey((await engine.signingKeys()).publicKey),
    driver: new SimulatedDriver(mkdtempSync(path.join(tmpdir(), "aster-agent-")), 0),
    transport,
    dataDir: tmpdir(),
    onError: (e) => errors.push(String(e)),
  });
});

test("no online node → creation is refused with a clear error", async () => {
  await assert.rejects(engine.createWorkload({ clientId, type: "wordpress", name: "Too early" }), /No server is available/);
  await agent.tick(); // first heartbeat brings the node online
});

let siteId: string;

test("WordPress: create → running, with a system hostname and generated credentials", async () => {
  siteId = await engine.createWorkload({ clientId, type: "wordpress", name: "My Blog", config: { phpVersion: "8.3" } });
  assert.equal((await workload(siteId)).status, "creating");
  await drain();

  const w = await workload(siteId);
  assert.equal(w.status, "running");
  assert.match(w.domains[0].hostname, /^my-blog-[0-9a-f]{6}\.n1\.aster\.test$/);
  assert.equal(w.runtime.internalHost, `aster-${w.slug}`);
  assert.ok(engine.readSecrets(w).adminPassword!.length >= 20);
  assert.ok(!w.secrets.includes(engine.readSecrets(w).adminPassword!), "secrets are encrypted at rest");
});

test("domains: add, make primary, remove; duplicates across workloads are refused", async () => {
  await engine.addDomain(siteId, "WWW.Example.com.");
  await assert.rejects(engine.addDomain(siteId, "www.example.com"), /already in use/);
  await assert.rejects(engine.addDomain(siteId, "not a domain"), /valid domain/);
  const custom = (await workload(siteId)).domains.find((d) => d.hostname === "www.example.com")!;
  await engine.setPrimaryDomain(siteId, custom.id);
  assert.equal((await engine.buildSpec(siteId)).domains[0], "www.example.com", "primary comes first in the spec");

  const system = (await workload(siteId)).domains.find((d) => d.isSystem)!;
  await assert.rejects(engine.removeDomain(siteId, system.id), /not found/, "the system hostname cannot be removed");
  await engine.removeDomain(siteId, custom.id);
  assert.equal((await workload(siteId)).domains.find((d) => d.isPrimary)?.isSystem, true, "primary falls back");
  await drain();
});

test("backups: create, restore (with automatic safety backup), delete", async () => {
  const backupId = await engine.createBackup(siteId, "before update");
  await drain();
  let w = await workload(siteId);
  assert.equal(w.backups[0].status, "ready");
  assert.ok(w.backups[0].sizeBytes > 0);

  await engine.restoreBackup(siteId, backupId);
  await drain();
  w = await workload(siteId);
  assert.deepEqual(w.backups.map((b) => `${b.kind}:${b.status}`).sort(), ["manual:ready", "system:ready"]);

  await engine.deleteBackup(siteId, backupId);
  await drain();
  assert.equal((await workload(siteId)).backups.length, 1);
});

test("staging: one per site, cloned on the same node, push back to live, removed with the site", async () => {
  const stagingId = await engine.createStaging(siteId);
  await assert.rejects(engine.createStaging(siteId), /already has a staging/);
  await drain();
  const staging = await workload(stagingId);
  assert.equal(staging.status, "running");
  assert.equal(staging.environment, "staging");
  assert.equal(staging.nodeId, (await workload(siteId)).nodeId);
  assert.notEqual(engine.readSecrets(staging).dbPassword, engine.readSecrets(await workload(siteId)).dbPassword);

  await engine.pushStagingToLive(stagingId);
  await drain();
  assert.ok((await workload(siteId)).backups.some((b) => b.note === "Before push from staging" && b.status === "ready"));

  await engine.deleteWorkload(siteId);
  await drain();
  assert.equal((await workload(siteId)).status, "deleted");
  assert.equal((await workload(stagingId)).status, "deleted");
  assert.equal((await workload(siteId)).domains.length, 0, "hostnames are freed");
});

test("apps: Git deploy records the commit; a failed build keeps the previous release live", async () => {
  await assert.rejects(engine.createWorkload({ clientId, type: "app", name: "API", config: { repoUrl: "git@github.com:x/y.git" } }), /HTTPS URL/);
  const appId = await engine.createWorkload({ clientId, type: "app", name: "API", config: { repoUrl: "https://github.com/acme/api.git", branch: "main", port: 3000 }, env: { NODE_ENV: "production" }, accessToken: "ghp_secret" });
  await drain();
  let app = await workload(appId);
  assert.equal(app.status, "running");
  assert.equal(app.deployments[0].status, "live");
  assert.equal(app.deployments[0].commitSha.length, 40);
  assert.ok(app.deployHookToken.length > 20);

  await engine.updateWorkloadConfig(appId, { branch: "will-fail" });
  await engine.deployWorkload(appId, "push");
  await drain();
  app = await workload(appId);
  assert.equal(app.status, "running", "still serving the last good release");
  assert.deepEqual(app.deployments.map((d) => d.status).sort(), ["failed", "live"]);

  const db = await dbm.getDb();
  const [job] = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.deploymentId, app.deployments.find((d) => d.status === "failed")!.id));
  assert.match(job.log, /ERROR: Remote branch will-fail not found/);
  assert.ok(!job.payload.includes("ghp_secret"), "job payloads are encrypted at rest");
});

test("databases get connection details and no public hostname", async () => {
  const dbId = await engine.createWorkload({ clientId, type: "database", name: "Orders DB", config: { engine: "postgres", version: "17" } });
  await drain();
  const d = await workload(dbId);
  assert.equal(d.status, "running");
  assert.equal(d.domains.length, 0);
  assert.match(d.runtime.dbName!, /^orders_db_[0-9a-f]{6}$/);
  await assert.rejects(engine.addDomain(dbId, "db.example.com"), /do not have domains/);
});

test("suspension stops the workload and blocks start until unsuspended", async () => {
  const id = await engine.createWorkload({ clientId, type: "static", name: "Docs", config: { repoUrl: "https://github.com/acme/docs.git", buildCommand: "npm run build", outputDir: "dist" } });
  await drain();
  await engine.suspendWorkload(id, "Overdue on payment");
  await drain();
  assert.equal((await workload(id)).status, "suspended");
  await assert.rejects(engine.powerWorkload(id, "start"), /suspended/);
  await assert.rejects(engine.deployWorkload(id, "push"), /suspended/);
  await engine.unsuspendWorkload(id);
  await drain();
  assert.equal((await workload(id)).status, "running");
});

test("the agent refuses tampered, foreign and replayed jobs", async () => {
  const id = await engine.createWorkload({ clientId, type: "database", name: "Victim", config: { engine: "redis" } });
  let captured: SignedJob | undefined;
  errors.length = 0;

  intercept = (jobs) => jobs.map((j) => ((captured = structuredClone(j)), { ...j, envelope: { ...j.envelope, type: "workload.delete" } }));
  await drain();
  assert.match(errors[0], /invalid signature/);
  assert.equal((await workload(id)).status, "creating", "nothing was executed");

  assert.equal(agent.reject({ ...captured!, envelope: { ...captured!.envelope } }), null, "the untouched envelope is genuine");
  assert.equal(agent.reject({ envelope: { ...captured!.envelope, nodeId: "someone-else" }, signature: captured!.signature }), "invalid signature");
  assert.equal(agent.reject({ envelope: { ...captured!.envelope, expiresAt: Date.now() + 9e9 }, signature: captured!.signature }), "invalid signature", "lifetime cannot be extended");

  intercept = () => [captured!];
  await drain();
  assert.equal((await workload(id)).status, "running", "genuine job runs…");
  intercept = () => [captured!];
  errors.length = 0;
  await agent.tick();
  assert.match(errors[0], /replayed job/, "…but only once");
  intercept = (j) => j;
});

test("jobs of one workload never run in parallel; a dead agent's job times out", async () => {
  const id = await engine.createWorkload({ clientId, type: "database", name: "Serial", config: { engine: "mysql" } });
  await engine.createBackup(id);
  const first = await engine.claimJobs(nodeId, 8);
  assert.deepEqual(first.map((j) => j.envelope.type), ["workload.create"], "the backup waits for the create");
  assert.equal((await engine.claimJobs(nodeId, 8)).length, 0);

  const db = await dbm.getDb();
  await db.update(dbm.schema.jobs).set({ startedAt: new Date(Date.now() - 31 * 60_000) }).where(eq(dbm.schema.jobs.id, first[0].envelope.id));
  const next = await engine.claimJobs(nodeId, 8);
  assert.deepEqual(next.map((j) => j.envelope.type), ["backup.create"]);
  const [stale] = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, first[0].envelope.id));
  assert.equal(stale.status, "failed");
  assert.equal(await engine.reportJob(nodeId, stale.id, { status: "succeeded", result: {} }), false, "late reports are ignored");
});

test("edge rules: redirects and IP deny are validated, stored and pushed to the node", async () => {
  const id = await engine.createWorkload({ clientId, type: "wordpress", name: "Edge" });
  await drain();

  await assert.rejects(engine.saveRedirects(id, [{ from: "no-slash", to: "/x", code: 301 }]), /Invalid source path/);
  await assert.rejects(engine.saveRedirects(id, [{ from: "/a", to: "javascript:alert(1)", code: 301 }]), /Invalid destination/);
  await assert.rejects(engine.saveRedirects(id, [{ from: "/a", to: "/a", code: 301 }]), /itself/);
  await engine.saveRedirects(id, [{ from: "/old", to: "https://example.com/new", code: 302 }, { from: "/promo", to: "/sale", code: 999 }]);

  await assert.rejects(engine.saveDenyIps(id, ["999.1.1.1"]), /Invalid IP/);
  await assert.rejects(engine.saveDenyIps(id, ["1.2.3.4; rm -rf /"]), /Invalid IP/);
  await engine.saveDenyIps(id, ["203.0.113.0/24", "198.51.100.7", "198.51.100.7", "2001:db8::1"]);

  const spec = await engine.buildSpec(id);
  assert.deepEqual(spec.redirects, [{ from: "/old", to: "https://example.com/new", code: 302 }, { from: "/promo", to: "/sale", code: 301 }]);
  assert.deepEqual(spec.denyIps, ["203.0.113.0/24", "198.51.100.7", "2001:db8::1"], "deduplicated");
  await drain();

  const db = await dbm.getDb();
  const logs = (await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.workloadId, id))).map((j) => j.log).join("\n");
  assert.match(logs, /2 redirect rule\(s\)/);
  assert.match(logs, /denying 3 address/);
});

test("WordPress inventory and updates round-trip through the agent", async () => {
  const [site] = (await (await dbm.getDb()).select().from(dbm.schema.workloads)).filter((w) => w.name === "Edge");
  const db = await dbm.getDb();
  const output = async (jobId: string) => JSON.parse(String((await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, jobId)))[0].result.output));

  const scan = await engine.runTool(site.id, "wp.inventory");
  await drain();
  assert.equal((await output(scan)).plugins.find((p: { name: string }) => p.name === "woocommerce").update, "9.3.0");

  await engine.runTool(site.id, "wp.update", { kind: "plugin", name: "woocommerce" });
  const rescan = await engine.runTool(site.id, "wp.inventory");
  await drain();
  const after = (await output(rescan)).plugins.find((p: { name: string }) => p.name === "woocommerce");
  assert.deepEqual([after.version, after.update], ["9.3.0", ""]);
});

test("metrics: only a node's own workloads, thinned to one sample per interval", async () => {
  const db = await dbm.getDb();
  const [site] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.name === "Edge");
  const sample = { slug: site.slug, cpuPercent: 12.6, memMb: 300, rxMb: 5, txMb: 9 };
  await engine.recordMetrics(nodeId, [sample, { ...sample, slug: "someone-elses-site" }]);
  await engine.recordMetrics(nodeId, [sample]);
  const rows = await db.select().from(dbm.schema.workloadMetrics);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cpuPercent, 13);
});

test("scheduled backups run once a day per live site or database", async () => {
  const first = await engine.runScheduledBackups();
  assert.ok(first.created >= 1);
  await drain();
  assert.equal((await engine.runScheduledBackups()).created, 0, "same day: nothing to do");
  const tomorrow = await engine.runScheduledBackups(new Date(Date.now() + 25 * 3_600_000));
  assert.equal(tomorrow.created, first.created);
  await drain();
});

test("SFTP: unique port per node, password rotation, pushed to the node; WordPress only", async () => {
  const db = await dbm.getDb();
  const a = await engine.createWorkload({ clientId, type: "wordpress", name: "Sftp A" });
  const b = await engine.createWorkload({ clientId, type: "wordpress", name: "Sftp B" });
  await drain();
  await engine.setSftp(a, true);
  await engine.setSftp(b, true);
  const [wa, wb] = [await workload(a), await workload(b)];
  assert.deepEqual([wa.config.sftpPort, wb.config.sftpPort], [22000, 22001]);

  const before = engine.readSecrets(wa).sftpPassword!;
  await engine.setSftp(a, true);
  assert.equal(engine.readSecrets(await workload(a)).sftpPassword, before, "enabling again keeps the password");
  await engine.setSftp(a, true, null, true);
  assert.notEqual(engine.readSecrets(await workload(a)).sftpPassword, before);

  const spec = await engine.buildSpec(a);
  assert.equal(spec.sftp?.port, 22000);
  assert.match(spec.sftp!.username, /^[a-z0-9]+$/);
  await engine.setSftp(a, false);
  assert.equal((await engine.buildSpec(a)).sftp, undefined);
  await drain();

  const [dbw] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.type === "database" && w.status === "running");
  await assert.rejects(engine.setSftp(dbw.id, true), /WordPress/);
});

test("database console: results come back as rows, errors as errors, every statement is audited", async () => {
  const db = await dbm.getDb();
  const [site] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.name === "Sftp B");
  const out = async (jobId: string) => (await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, jobId)))[0];

  const tables = await engine.runDbJob(site.id, "tables");
  const query = await engine.runDbJob(site.id, "query", "SELECT ID, post_title FROM wp_posts;");
  const bad = await engine.runDbJob(site.id, "query", "SELECT syntax_error");
  await drain();
  assert.ok(JSON.parse(String((await out(tables)).result.output)).rows.some((r: string[]) => r[0] === "wp_posts"));
  const result = JSON.parse(String((await out(query)).result.output));
  assert.deepEqual(result.columns.slice(0, 2), ["ID", "post_title"]);
  assert.equal(result.rows[2][3], null, "NULL survives as null");
  assert.equal((await out(bad)).status, "failed");
  assert.match((await out(bad)).error, /SQL syntax/);

  assert.equal(engine.isReadOnlySql("select 1"), true);
  assert.equal(engine.isReadOnlySql("  DELETE FROM wp_posts"), false);
  assert.equal(engine.isReadOnlySql("select 1; drop table wp_posts"), false, "stacked statements are not read-only");
  await assert.rejects(engine.runDbJob(site.id, "query", "   "), /one SQL statement/);

  const audited = (await db.select().from(dbm.schema.auditLog)).filter((a) => a.action === "db.query");
  assert.equal(audited.length, 2);
  assert.equal(audited[0].meta.readOnly, true);

  const redis = await engine.createWorkload({ clientId, type: "database", name: "Cache", config: { engine: "redis" } });
  await drain();
  await assert.rejects(engine.runDbJob(redis, "tables"), /MySQL and PostgreSQL/);
});

test("file manager: browse, edit, create and delete go through the agent; traversal is refused", async () => {
  const db = await dbm.getDb();
  const [site] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.name === "Sftp B");
  const out = async (jobId: string) => {
    const [j] = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, jobId));
    return { status: j.status, error: j.error, data: j.result.output ? JSON.parse(String(j.result.output)) : null };
  };
  const run = async (action: "list" | "read" | "write" | "mkdir" | "delete", path: string, content?: string) => {
    const id = await engine.runFilesJob(site.id, action, path, content);
    await drain();
    return out(id);
  };

  for (const bad of ["../etc/passwd", "wp-content/../../x", `a/${String.fromCharCode(0)}b`]) await assert.rejects(engine.runFilesJob(site.id, "read", bad), /Invalid path/);
  assert.equal(engine.cleanPath("/wp-content//themes/./x/"), "wp-content/themes/x");
  await assert.rejects(engine.runFilesJob(site.id, "delete", ""), /Invalid path/, "the site root cannot be deleted");

  const root = await run("list", "");
  assert.ok(root.data.entries.some((e: { name: string; type: string }) => e.name === "wp-content" && e.type === "dir"));
  assert.match((await run("read", "wp-config.php")).data.content, /DB_NAME/);

  await run("write", "robots.txt", "User-agent: *\n");
  assert.equal((await run("read", "robots.txt")).data.content, "User-agent: *\n");
  await run("mkdir", "wp-content/mu-plugins");
  assert.ok((await run("list", "wp-content")).data.entries.some((e: { name: string }) => e.name === "mu-plugins"));
  await run("delete", "robots.txt");
  assert.equal((await run("read", "robots.txt")).status, "failed");
  await assert.rejects(engine.runFilesJob(site.id, "write", "big.txt", "x".repeat(1_000_001)), /too large/);

  const audited = (await db.select().from(dbm.schema.auditLog)).filter((a) => a.action.startsWith("files."));
  assert.deepEqual(audited.map((a) => a.action).sort(), ["files.delete", "files.mkdir", "files.write"], "changes are audited, reads are not");
});

test("edge cache settings are validated and reach the node", async () => {
  const db = await dbm.getDb();
  const [site] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.name === "Sftp B");
  await assert.rejects(engine.saveCache(site.id, { enabled: true, ttlMinutes: 60, bypass: ["members"] }), /Invalid path/);
  await engine.saveCache(site.id, { enabled: true, ttlMinutes: 12345, bypass: ["/members", "/members", " /api "] });
  assert.deepEqual((await engine.buildSpec(site.id)).cache, { enabled: true, ttlMinutes: 60, bypass: ["/members", "/api"] }, "unknown TTL falls back, paths are deduplicated");
  await drain();
  await engine.saveCache(site.id, { enabled: false, ttlMinutes: 60, bypass: [] });
  assert.equal((await engine.buildSpec(site.id)).cache, undefined);
  await drain();
});

test("DNS: records are validated, zones are unique, every change syncs all nodes with a higher serial", async () => {
  const db = await dbm.getDb();
  const rec = (type: string, name: string, value: string, priority = 0) => engine.cleanDnsRecord({ type, name, value, ttl: 3600, priority });
  assert.deepEqual(rec("a", "WWW.", "203.0.113.10"), { name: "www", type: "A", value: "203.0.113.10", ttl: 3600, priority: 0 });
  assert.equal(rec("MX", "", "Mail.Example.com", 10).value, "mail.example.com.");
  assert.equal(rec("MX", "@", "mail.example.com", 10).priority, 10);
  assert.throws(() => rec("A", "www", "999.1.1.1"), /IPv4/);
  assert.throws(() => rec("CNAME", "@", "example.net"), /root of the domain/);
  assert.throws(() => rec("A", "bad name", "1.2.3.4"), /Invalid record name/);
  assert.throws(() => rec("TXT", "@", ["line1", "line2"].join(String.fromCharCode(10))), /Invalid TXT/);
  assert.throws(() => rec("PTR", "@", "x"), /Unsupported/);
  assert.equal(rec("TXT", "_dmarc", 'v=DMARC1; p="none"').value, 'v=DMARC1; p="none"');
  assert.equal(rec("A", "*.dev", "203.0.113.10").name, "*.dev");

  const zoneId = await engine.createZone(clientId, "Example-Zone.com.");
  await assert.rejects(engine.createZone(clientId, "example-zone.com"), /already managed/);
  await assert.rejects(engine.createZone(clientId, "not a domain"), /valid domain/);
  await db.insert(dbm.schema.dnsRecords).values({ zoneId, ...rec("A", "@", "203.0.113.10") });
  await engine.touchZone(zoneId);

  const queued = (await db.select().from(dbm.schema.jobs)).filter((j) => j.type === "dns.sync");
  assert.deepEqual(queued.map((j) => j.status).sort(), ["cancelled", "queued"], "only the newest full sync stays queued");
  await drain();
  const [done] = (await db.select().from(dbm.schema.jobs)).filter((j) => j.type === "dns.sync" && j.status === "succeeded");
  assert.match(done.log, /1 zone\(s\), 1 record\(s\)/);
  assert.match(done.log, /example-zone\.com serial 2/);
});

test("bot protection, CDN and APM: validated, carried by the spec, reported by the agent", async () => {
  const db = await dbm.getDb();
  const [site] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.name === "Sftp B");
  const [database] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.type === "database" && w.status === "running");

  assert.equal((await engine.buildSpec(site.id)).bots, undefined, "off by default");
  await assert.rejects(engine.saveBots(site.id, { blockBad: true, blockAi: false, protectLogin: true, ratePerMinute: 5 }), /between 30 and 100000/);
  await engine.saveBots(site.id, { blockBad: true, blockAi: true, protectLogin: true, ratePerMinute: 600 });
  assert.deepEqual((await engine.buildSpec(site.id)).bots, { blockBad: true, blockAi: true, ratePerMinute: 600, protectLogin: true });
  await assert.rejects(engine.saveBots(database.id, { blockBad: true, blockAi: false, protectLogin: false, ratePerMinute: 0 }), /web services/);

  await engine.saveCdn(site.id, { enabled: true, maxAgeDays: 999 });
  assert.deepEqual((await engine.buildSpec(site.id)).cdn, { enabled: true, maxAgeDays: 30 }, "unknown lifetime falls back to 30 days");
  await assert.rejects(engine.saveCdn(database.id, { enabled: true, maxAgeDays: 30 }), /WordPress/);
  await drain();
  const logs = (await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.workloadId, site.id))).map((j) => j.log).join("\n");
  assert.match(logs, /bad bots blocked, AI crawlers blocked, 600 req\/min per IP, login protected/);
  assert.match(logs, /static assets cached 30 day/);

  const jobId = await engine.runApmJob(site.id, 7);
  await drain();
  const [job] = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, jobId));
  const report = JSON.parse(String(job.result.output));
  assert.equal(report.minutes, 60, "unknown range falls back to one hour");
  assert.ok(report.requests > 0 && report.p95Ms >= report.avgMs);
  assert.equal(report.slowest[0].path, "/checkout/");
  await assert.rejects(engine.runApmJob(database.id, 60), /web services/);
});

test("SFTP keys: only real OpenSSH public keys, no duplicates, delivered to the node", async () => {
  const db = await dbm.getDb();
  const [site] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.name === "Sftp B");
  const good = `ssh-ed25519 ${"A".repeat(68)} me@laptop`;
  await assert.rejects(engine.addSftpKey(site.id, "x", "-----BEGIN OPENSSH PRIVATE KEY-----"), /public key/);
  await assert.rejects(engine.addSftpKey(site.id, "x", "ssh-ed25519 short"), /public key/);
  await engine.addSftpKey(site.id, "Laptop", good);
  await assert.rejects(engine.addSftpKey(site.id, "Again", good.replace("me@laptop", "other comment")), /already authorised/);
  assert.deepEqual((await engine.buildSpec(site.id)).sftp?.keys, [`ssh-ed25519 ${"A".repeat(68)}`], "the free-text comment is dropped");
  await engine.removeSftpKey(site.id, `ssh-ed25519 ${"A".repeat(68)}`);
  assert.deepEqual((await engine.buildSpec(site.id)).sftp?.keys, []);
  await drain();
});

test("alerts: only actionable items, filtered by role, gone once handled", async () => {
  const { accountAlerts } = await import("../src/lib/alerts");
  const db = await dbm.getDb();
  // Alerts belong to the company, not to the person: another company of the same user stays quiet.
  const [{ id: companyId }] = await db.insert(dbm.schema.companies).values({ name: "Alerts Ltd" }).returning();
  const [{ id: otherCompany }] = await db.insert(dbm.schema.companies).values({ name: "Quiet Ltd" }).returning();
  const [broken] = await db.insert(dbm.schema.workloads).values({ clientId, companyId, nodeId, type: "app", name: "Broken app", slug: "broken-app-000000", status: "error" }).returning();
  const [invoice] = await db.insert(dbm.schema.invoices).values({ clientId, companyId, currency: "EUR", total: 1000, subtotal: 1000, dueDate: new Date(Date.now() - 86_400_000) }).returning();
  assert.deepEqual(await accountAlerts(otherCompany, "owner"), []);

  const kinds = (list: { kind: string }[]) => [...new Set(list.map((a) => a.kind))].sort();
  const owner = await accountAlerts(companyId, "owner");
  assert.ok(owner.some((a) => a.text === "{name} needs attention" && a.vars?.name === "Broken app"));
  assert.ok(owner.some((a) => a.text === "Invoice #{n} is overdue"));
  assert.ok(!kinds(await accountAlerts(companyId, "developer")).includes("invoice"), "developers do not see billing");
  assert.deepEqual(kinds(await accountAlerts(companyId, "billing")), ["invoice"], "billing sees only billing");

  await db.update(dbm.schema.invoices).set({ status: "paid" }).where(eq(dbm.schema.invoices.id, invoice.id));
  await db.update(dbm.schema.workloads).set({ status: "deleted" }).where(eq(dbm.schema.workloads.id, broken.id));
  const after = await accountAlerts(companyId, "owner");
  assert.ok(!after.some((a) => a.kind === "invoice" || a.vars?.name === "Broken app"));
});

test("uploads: size-limited, decoded on the node, and their content is scrubbed from the queue afterwards", async () => {
  const db = await dbm.getDb();
  const [site] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.name === "Sftp B");
  const { decryptJson } = await import("../src/lib/crypto");
  await assert.rejects(engine.runFilesJob(site.id, "write", "big.bin", "A".repeat(7_100_000), null, "base64"), /5 MB/);

  const jobId = await engine.runFilesJob(site.id, "write", "wp-content/uploads/logo.png", Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]).toString("base64"), null, "base64");
  const before = (await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, jobId)))[0];
  assert.ok(decryptJson<{ content?: string }>(before.payload, {}).content, "present while queued");
  await drain();
  const after = (await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, jobId)))[0];
  assert.equal(after.status, "succeeded");
  assert.equal(decryptJson<{ content?: string }>(after.payload, {}).content, undefined, "gone once the job is final");

  const read = await engine.runFilesJob(site.id, "read", "wp-content/uploads/logo.png");
  await drain();
  assert.match(String((await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, read)))[0].result.output), /uploaded file, 8 bytes/);
});

test("uptime: two failures open an incident, one success closes it, simulated nodes are skipped", async () => {
  const uptime = await import("../src/platform/uptime");
  const db = await dbm.getDb();
  const [site] = (await db.select().from(dbm.schema.workloads)).filter((w) => w.name === "Sftp B");
  let answer: { status: number; ms: number; error?: string } = { status: 200, ms: 120 };
  const probe = async () => answer;
  const at = (min: number) => new Date(Date.now() + min * 60_000);

  assert.equal((await uptime.runUptimeChecks(at(0), probe)).checked, 0, "the node reports a simulated driver");
  await db.update(dbm.schema.nodes).set({ driver: "docker" });
  await db.update(dbm.schema.workloads).set({ status: "stopped" }).where(ne(dbm.schema.workloads.id, site.id));

  const incidents: number[] = [];
  for (const [i, a] of [{ status: 200, ms: 100 }, { status: 502, ms: 40 }, { status: 0, ms: 10_000, error: "timeout" }, { status: 503, ms: 30 }, { status: 200, ms: 140 }].entries()) {
    answer = a;
    incidents.push((await uptime.runUptimeChecks(at(i * 5), probe)).incidents);
  }
  assert.deepEqual(incidents, [0, 0, 1, 0, 0], "one blip is not an incident; a long outage alerts once");
  const summary = await uptime.uptimeSummary(site.id);
  assert.equal(summary.checks, 5);
  assert.equal(summary.percent, 40);
  assert.equal(summary.last?.ok, true);
  await db.update(dbm.schema.nodes).set({ driver: "simulated" });
});

test("off-site backups: uploaded, restorable without the local copy, failures reported, keys scrubbed from finished jobs", async () => {
  const db = await dbm.getDb();
  const { updateSettings } = await import("../src/lib/settings");
  const { decryptJson } = await import("../src/lib/crypto");
  const id = await engine.createWorkload({ clientId, type: "database", name: "Offsite DB", config: { engine: "postgres" } });
  await drain();
  const base = { keepScheduled: 14, endpoint: "https://s3.example.test", region: "eu", prefix: "/aster/", accessKey: "AKIA-TEST", secretKey: "very-secret", keepLocal: false };

  // Off or incomplete settings: nothing is sent to the node.
  await updateSettings("backups", { ...base, offsiteEnabled: true, bucket: "" });
  assert.equal(await engine.offsiteTarget(), undefined);
  await assert.rejects(engine.testOffsite(nodeId), /Enable off-site backups/);

  await updateSettings("backups", { ...base, offsiteEnabled: true, bucket: "good-bucket" });
  assert.equal((await engine.offsiteTarget())?.prefix, "aster", "slashes trimmed");
  const backupId = await engine.createBackup(id, "offsite");
  assert.equal((await workload(id)).backups[0].offsite, "pending");
  await drain();
  assert.deepEqual((await workload(id)).backups.map((b) => [b.status, b.offsite]), [["ready", "uploaded"]]);
  const jobs = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.backupId, backupId));
  assert.ok(jobs.every((j) => !JSON.stringify(decryptJson(j.payload, {})).includes("very-secret")), "storage keys do not linger in finished jobs");

  // keepLocal=false removed the node's copy: the restore has to come from the bucket.
  await engine.restoreBackup(id, backupId);
  await drain();
  const restore = (await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.type, "backup.restore"))).at(-1)!;
  assert.equal(restore.status, "succeeded");
  assert.match(restore.log, /downloading from s3:\/\/good-bucket\/aster\//);

  // A failed upload keeps the backup usable and says why.
  await updateSettings("backups", { ...base, offsiteEnabled: true, bucket: "fail-bucket", keepLocal: true });
  await engine.createBackup(id, "will not upload");
  await drain();
  const failed = (await workload(id)).backups.find((b) => b.note === "will not upload")!;
  assert.deepEqual([failed.status, failed.offsite], ["ready", "failed"]);
  assert.match(failed.offsiteError, /AccessDenied/);

  const testId = await engine.testOffsite(nodeId);
  await drain();
  const [probe] = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, testId));
  assert.deepEqual([probe.status, probe.error], ["failed", "AccessDenied: simulated failure"]);

  await updateSettings("backups", { ...base, offsiteEnabled: false, bucket: "good-bucket" });
});

test("migration: inputs are confined, a safety backup runs first, and the password never stays in the queue", async () => {
  const db = await dbm.getDb();
  const { decryptJson } = await import("../src/lib/crypto");
  const clean = engine.cleanMigrationSource;
  const ssh = { type: "ssh", host: "old.example.com", port: "2222", user: "site_user", password: "hunter2-secret", path: "public_html/" };
  assert.deepEqual(clean(ssh), { source: { type: "ssh", host: "old.example.com", port: 2222, user: "site_user", password: "hunter2-secret", path: "public_html" }, label: "site_user@old.example.com" });
  for (const bad of [{ host: "localhost" }, { host: "10.0.0.5" }, { host: "192.168.1.1" }, { host: "172.20.0.1" }, { host: "node.internal" }, { host: "a.com; rm -rf /" }, { user: "root;id" }, { user: "-oProxyCommand=x" }, { path: "../../etc" }, { path: "a b" }, { path: "$(id)" }, { port: "0" }, { password: "" }, { password: "a\nb" }])
    assert.throws(() => clean({ ...ssh, ...bad }), engine.PlatformError, JSON.stringify(bad));
  assert.equal(clean({ type: "archive", url: "https://backups.example.com/site.zip?sig=1" }).label, "backups.example.com");
  for (const url of ["http://example.com/a.zip", "https://user:pw@example.com/a.zip", "https://127.0.0.1/a.zip", "https://169.254.169.254/latest", "https://[::1]/a.zip", "https://intranet/a.zip", "file:///etc/passwd", "nope"])
    assert.throws(() => clean({ type: "archive", url }), engine.PlatformError, url);

  const id = await engine.createWorkload({ clientId, type: "wordpress", name: "Moved" });
  await drain();
  const jobId = await engine.startMigration(id, ssh);
  await assert.rejects(engine.startMigration(id, ssh), /already in progress/);
  await drain();
  const w = await workload(id);
  assert.ok(w.backups.some((b) => b.note === "Before migration" && b.status === "ready"));
  assert.equal(w.runtime.version, "6.7", "the site now runs the migrated WordPress version");
  const [run] = await engine.listMigrations(id);
  assert.deepEqual([run.id, run.status, run.label, run.summary.oldUrl, run.summary.tablePrefix], [jobId, "succeeded", "site_user@old.example.com", "https://old-site.example", "wpx_"]);
  const [job] = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.id, jobId));
  assert.deepEqual(decryptJson(job.payload, {}), { label: "site_user@old.example.com" }, "source and password are gone once the job is final");
  assert.ok(!job.log.includes("hunter2"));

  await engine.startMigration(id, { ...ssh, host: "fail.example.com" });
  await drain();
  const [failed] = await engine.listMigrations(id);
  assert.deepEqual([failed.status, failed.error], ["failed", "Permission denied (password)"]);
  assert.equal((await workload(id)).status, "running", "a failed migration leaves the site up");
});

test("rollback: a kept build goes live again without rebuilding; an unhealthy release leaves the old one serving", async () => {
  const db = await dbm.getDb();
  const id = await engine.createWorkload({ clientId, type: "app", name: "Rolling", config: { repoUrl: "https://github.com/acme/rolling.git", branch: "main", port: 3000 } });
  await drain();
  await engine.deployWorkload(id, "manual");
  await drain();
  const [live, first] = await engine.rollbackCandidates(id);
  assert.ok(live && first && live.id !== first.id);

  const rb = await engine.rollbackDeployment(id, first.id);
  const [job] = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.deploymentId, rb));
  const { decryptJson } = await import("../src/lib/crypto");
  assert.equal(decryptJson<{ rollbackTo?: string }>(job.payload, {}).rollbackTo, first.id);
  await drain();
  const [done] = await db.select().from(dbm.schema.deployments).where(eq(dbm.schema.deployments.id, rb));
  assert.deepEqual([done.status, done.trigger, done.rollbackOf, done.commitSha], ["live", "rollback", first.id, first.commitSha], "keeps the commit of the build it restored");
  const [finished] = await db.select().from(dbm.schema.jobs).where(eq(dbm.schema.jobs.deploymentId, rb));
  assert.ok(/re-tagging image/.test(finished.log) && !/git clone/.test(finished.log));
  assert.ok(!(await engine.rollbackCandidates(id)).some((d) => d.trigger === "rollback"), "a rollback is not itself a build to roll back to");

  await assert.rejects(engine.rollbackDeployment(id, "00000000-0000-4000-8000-000000000000"), /too old/);
  const dbw = await engine.createWorkload({ clientId, type: "database", name: "NoRoll", config: { engine: "redis" } });
  await assert.rejects(engine.rollbackDeployment(dbw, first.id), /Only applications/);

  await engine.updateWorkloadConfig(id, { branch: "unhealthy" });
  await drain();
  const bad = await engine.deployWorkload(id, "manual");
  await drain();
  const [failed] = await db.select().from(dbm.schema.deployments).where(eq(dbm.schema.deployments.id, bad));
  assert.equal(failed.status, "failed");
  assert.equal((await workload(id)).status, "running", "the previous version keeps serving");
});

test("previews: other branches get their own environment, refreshed on push and removed with the branch", async () => {
  const push = (ref: string, extra: Record<string, unknown> = {}) => engine.parsePush({ ref, ...extra });
  assert.deepEqual(push("refs/heads/feature/login"), { branch: "feature/login", deleted: false });
  assert.deepEqual(push("refs/heads/old", { after: "0000000000000000000000000000000000000000" }), { branch: "old", deleted: true });
  assert.deepEqual(push("refs/heads/old", { deleted: true }), { branch: "old", deleted: true });
  for (const bad of ["refs/tags/v1", "refs/heads/../../etc", "refs/heads/-rf", "main", 42]) assert.equal(engine.parsePush({ ref: bad }), null, String(bad));
  assert.equal(engine.parsePush(null), null);

  const id = await engine.createWorkload({ clientId, type: "app", name: "Previewed", config: { repoUrl: "https://github.com/acme/previewed.git", branch: "main", port: 3000 }, env: { API_KEY: "k" } });
  await drain();
  assert.equal((await engine.handlePush(id, null)).action, "deployed", "a plain POST still deploys");
  assert.equal((await engine.handlePush(id, push("refs/heads/main"))).action, "deployed");
  assert.equal((await engine.handlePush(id, push("refs/heads/feature/login"))).action, "ignored", "previews are opt-in");
  await drain();

  await engine.setPreviews(id, true);
  const created = await engine.handlePush(id, push("refs/heads/feature/login"));
  assert.equal(created.action, "preview");
  await drain();
  const [preview] = await engine.previewsOf(id);
  const pw = await workload(preview.id);
  assert.deepEqual([pw.environment, pw.parentId, pw.config.branch, pw.config.previews, pw.status, pw.deployHookToken], ["preview", id, "feature/login", false, "running", ""]);
  assert.match(pw.domains[0].hostname, /^pr-feature-login-[0-9a-f]{6}\./);
  assert.equal((await engine.buildSpec(preview.id)).env?.API_KEY, "k", "same environment as the app");

  const again = await engine.handlePush(id, push("refs/heads/feature/login"));
  assert.deepEqual([again.action, (await engine.previewsOf(id)).length], ["preview", 1], "a second push redeploys the same preview");
  await drain();
  await assert.rejects(engine.handlePush(preview.id, push("refs/heads/x")), /built from the live app/);

  await engine.handlePush(id, push("refs/heads/b2"));
  await engine.handlePush(id, push("refs/heads/b3"));
  await assert.rejects(engine.handlePush(id, push("refs/heads/b4")), /up to 3 previews/);
  await drain();

  assert.equal((await engine.handlePush(id, push("refs/heads/feature/login", { deleted: true }))).action, "preview_removed");
  await drain();
  assert.deepEqual((await engine.previewsOf(id)).map((p) => p.config.branch).sort(), ["b2", "b3"]);
  await engine.setPreviews(id, false);
  await drain();
  assert.equal((await engine.previewsOf(id)).length, 0, "switching previews off removes them");
  assert.equal((await workload(id)).status, "running");
});
