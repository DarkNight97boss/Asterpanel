import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";
import type { Transporter } from "nodemailer";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";
process.env.APP_URL = "https://panel.example.test";

let dbm: typeof import("../src/db");
let health: typeof import("../src/lib/node-health");
const outbox: { to: string; subject: string }[] = [];

before(async () => {
  dbm = await import("../src/db");
  health = await import("../src/lib/node-health");
  const { setTransportForTests } = await import("../src/lib/mail/transport");
  setTransportForTests({ sendMail: async (m: { to: string; subject: string }) => void outbox.push(m) } as unknown as Transporter);
  const { getSettings, updateSettings } = await import("../src/lib/settings");
  await updateSettings("mail", { ...(await getSettings("mail")), enabled: true, host: "smtp.test", fromEmail: "noreply@example.test", staffEmail: "ops@example.test" });
});

test("server problems are announced once, and once more when they are gone", async () => {
  const db = await dbm.getDb();
  const { flushNotifications } = await import("../src/lib/notify");
  const fresh = new Date();
  const [node] = await db.insert(dbm.schema.nodes).values({ name: "n1", tokenHash: "x", status: "online", lastSeenAt: fresh, stats: { diskTotalGb: 100, diskUsedGb: 50, memTotalMb: 1000, memUsedMb: 500 } }).returning();
  await db.insert(dbm.schema.nodes).values({ name: "never-installed", tokenHash: "y" });
  assert.deepEqual(await health.checkNodes(), { raised: 0, cleared: 0 });

  await db.update(dbm.schema.nodes).set({ stats: { diskTotalGb: 100, diskUsedGb: 93, memTotalMb: 1000, memUsedMb: 500 } }).where(eq(dbm.schema.nodes.id, node.id));
  assert.deepEqual(await health.checkNodes(), { raised: 1, cleared: 0 });
  assert.deepEqual(await health.checkNodes(), { raised: 0, cleared: 0 }, "not again while it lasts");

  await db.update(dbm.schema.nodes).set({ lastSeenAt: new Date(Date.now() - 3_600_000) }).where(eq(dbm.schema.nodes.id, node.id));
  assert.deepEqual(await health.checkNodes(), { raised: 1, cleared: 1 }, "offline replaces what cannot be measured any more");
  await db.update(dbm.schema.nodes).set({ lastSeenAt: new Date(), stats: { diskTotalGb: 100, diskUsedGb: 40 } }).where(eq(dbm.schema.nodes.id, node.id));
  assert.deepEqual(await health.checkNodes(), { raised: 0, cleared: 1 });
  await flushNotifications();
  assert.deepEqual(outbox.map((m) => [m.to, m.subject.replace(/^\[[^\]]*\] /, "")]), [["ops@example.test", "n1: disk 93% full"], ["ops@example.test", "n1: offline: the agent stopped reporting"], ["ops@example.test", "n1: disk: back to normal"], ["ops@example.test", "n1: offline: back to normal"]]);
});

test("Prometheus metrics: well-formed, labelled, and without customer data", async () => {
  const db = await dbm.getDb();
  const [u] = await db.insert(dbm.schema.users).values({ email: "secret-customer@example.test", passwordHash: "x" }).returning();
  const [n] = await db.select().from(dbm.schema.nodes).where(eq(dbm.schema.nodes.name, "n1"));
  await db.insert(dbm.schema.workloads).values({ clientId: u.id, nodeId: n.id, type: "wordpress", name: "Secret Customer Blog", slug: "secret-blog-000000", status: "running" });
  const text = await health.prometheusMetrics();
  assert.match(text, /^# HELP aster_node_up /);
  assert.ok(text.includes('aster_node_up{node="n1"} 1') && text.includes('aster_node_up{node="never-installed"} 0'));
  assert.ok(text.includes('aster_workloads{type="wordpress",status="running"} 1'));
  assert.ok(text.includes('aster_node_disk_used_ratio{node="n1"} 0.4'));
  assert.ok(!/secret/i.test(text), "no customer or site names");
  for (const line of text.trim().split("\n")) assert.match(line, /^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[\d.]+)$/, line);
});
