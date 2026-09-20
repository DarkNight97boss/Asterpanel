import assert from "node:assert/strict";
import { before, test } from "node:test";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let report: typeof import("../src/lib/site-report");
let uptime: typeof import("../src/platform/uptime");
let siteId: string;

before(async () => {
  dbm = await import("../src/db");
  report = await import("../src/lib/site-report");
  uptime = await import("../src/platform/uptime");
  const db = await dbm.getDb();
  const [user] = await db.insert(dbm.schema.users).values({ email: "rep@example.test", passwordHash: "x" }).returning();
  const [node] = await db.insert(dbm.schema.nodes).values({ name: "rep-node", tokenHash: "h", driver: "docker" }).returning();
  const [w] = await db.insert(dbm.schema.workloads).values({ clientId: user.id, nodeId: node.id, type: "wordpress", name: "Caffè Löwe", slug: "caffe-1", status: "running", config: { scanLastAt: "2026-08-20T10:00:00Z", scanFindings: 0, autoUpdate: "minor" }, secrets: "", runtime: { diskUsedMb: 2048 } }).returning();
  siteId = w.id;
  await db.insert(dbm.schema.domains).values({ workloadId: w.id, hostname: "caffe.example.test", isPrimary: true });
});

test("months: format, bounds, no future", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const r = report.monthRange("2026-08", now);
  assert.equal(r.from.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(r.to.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.doesNotThrow(() => report.monthRange("2026-09", now));
  assert.throws(() => report.monthRange("2026-10", now), /No data/);
  assert.throws(() => report.monthRange("2026-13", now), /looks like/);
  assert.throws(() => report.monthRange("../etc", now), /looks like/);
  assert.deepEqual(report.recentMonths(3, new Date("2026-01-15T00:00:00Z")), ["2026-01", "2025-12", "2025-11"]);
});

test("uptime checks are tallied per day and outlive the raw checks", async () => {
  const db = await dbm.getDb();
  const probes = [{ status: 200, ms: 100 }, { status: 200, ms: 300 }, { status: 0, ms: 5, error: "timeout" }];
  for (const [i, p] of probes.entries()) await uptime.runUptimeChecks(new Date(`2026-08-10T0${i}:00:00Z`), async () => p);
  await uptime.runUptimeChecks(new Date("2026-08-11T00:00:00Z"), async () => ({ status: 503, ms: 50 }));
  // A month later the raw checks are gone, the tally is not.
  await uptime.runUptimeChecks(new Date("2026-09-15T00:00:00Z"), async () => ({ status: 200, ms: 80 }));
  assert.equal((await db.select().from(dbm.schema.uptimeChecks)).length, 1);
  const august = await report.siteReport(siteId, "2026-08", new Date("2026-09-20T00:00:00Z"));
  assert.deepEqual(august.uptime, { percent: 50, avgMs: 200, checks: 4, daysMeasured: 2, daysWithDowntime: ["2026-08-10", "2026-08-11"] });
});

test("the report counts only its month, and says when nothing was measured", async () => {
  const db = await dbm.getDb();
  await db.insert(dbm.schema.backups).values([
    { workloadId: siteId, status: "ready", offsite: "uploaded", createdAt: new Date("2026-08-05T03:00:00Z") },
    { workloadId: siteId, status: "ready", createdAt: new Date("2026-08-06T03:00:00Z") },
    { workloadId: siteId, status: "failed", createdAt: new Date("2026-08-07T03:00:00Z") },
    { workloadId: siteId, status: "ready", createdAt: new Date("2026-09-01T00:00:00Z") },
  ]);
  const now = new Date("2026-09-20T00:00:00Z");
  const august = await report.siteReport(siteId, "2026-08", now);
  assert.deepEqual(august.backups, { made: 2, failed: 1, offsite: 1, latest: new Date("2026-08-06T03:00:00Z") });
  assert.equal(august.deployments, null);
  assert.equal(august.security?.findings, 0);
  const july = await report.siteReport(siteId, "2026-07", now);
  assert.equal(july.uptime, null);
  assert.equal(july.backups.made, 0);
});

test("the PDF renders, accents included, with a safe file name", async () => {
  const { filename, bytes } = await report.renderSiteReportPdf(await report.siteReport(siteId, "2026-08", new Date("2026-09-20T00:00:00Z")));
  assert.equal(filename, "report-caff-l-we-2026-08.pdf");
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  assert.ok(bytes.length > 1500);
});
