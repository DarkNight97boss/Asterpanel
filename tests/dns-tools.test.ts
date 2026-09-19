import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";
import { DNS_TEMPLATES, parseZoneFile } from "../src/platform/dns-tools";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let engine: typeof import("../src/platform/engine");
let zoneId: string;

before(async () => {
  dbm = await import("../src/db");
  engine = await import("../src/platform/engine");
  const db = await dbm.getDb();
  const [u] = await db.insert(dbm.schema.users).values({ email: "dns@example.test", passwordHash: "x" }).returning();
  zoneId = await engine.createZone(u.id, "example.com");
});

const records = async () => (await (await dbm.getDb()).select().from(dbm.schema.dnsRecords).where(eq(dbm.schema.dnsRecords.zoneId, zoneId))).map((r) => `${r.name} ${r.type} ${r.priority} ${r.value}`).sort();

test("zone files: owners, TTLs, $ORIGIN, quoted TXT, multi-line SOA and foreign names", () => {
  const { records: r, skipped } = parseZoneFile(
    `$TTL 300
$ORIGIN example.com.
@   IN SOA ns1.old.net. admin.old.net. (
        2026091901 ; serial
        3600 900 604800 300 )
@       IN NS  ns1.old.net.
@       IN A   203.0.113.10
        IN AAAA 2001:db8::10 ; same owner as the line above
www 600 IN CNAME example.com.
@       IN MX 10 mail
mail.example.com. IN A 203.0.113.11
@       IN TXT "v=spf1 include:_spf.example.net ~all; not a comment" " second part"
_sip._tcp IN SRV 10 5 5060 sip
other.org. IN A 198.51.100.1
@       IN HINFO "PC" "Linux"
`,
    "example.com",
  );
  assert.deepEqual(r.map((x) => `${x.name} ${x.ttl} ${x.type} ${x.priority} ${x.value}`), [
    "@ 300 A 0 203.0.113.10",
    "@ 300 AAAA 0 2001:db8::10",
    "www 600 CNAME 0 example.com",
    "@ 300 MX 10 mail.example.com",
    "mail 300 A 0 203.0.113.11",
    "@ 300 TXT 0 v=spf1 include:_spf.example.net ~all; not a comment second part",
    "_sip._tcp 300 SRV 10 5 5060 sip.example.com",
  ]);
  assert.equal(skipped.length, 2, "a name outside the zone and an unsupported type are reported, not guessed");
});

test("templates and imports add validated records, leave clashes out, and every change can be undone", async () => {
  const m365 = DNS_TEMPLATES.find((t) => t.id === "microsoft-365")!;
  let res = await engine.addDnsRecords(zoneId, m365.records("example.com"), "Template: Microsoft 365");
  assert.deepEqual([res.added, res.skipped], [3, []]);
  assert.ok((await records()).includes("@ MX 0 example-com.mail.protection.outlook.com."));
  res = await engine.addDnsRecords(zoneId, m365.records("example.com"), "again");
  assert.deepEqual([res.added, res.skipped.length], [0, 3], "applying twice adds nothing");

  res = await engine.addDnsRecords(zoneId, [{ name: "autodiscover", type: "A", value: "203.0.113.5", ttl: 300, priority: 0 }, { name: "shop", type: "A", value: "999.1.1.1", ttl: 300, priority: 0 }, { name: "shop", type: "A", value: "203.0.113.9", ttl: 300, priority: 0 }], "import");
  assert.equal(res.added, 1);
  assert.match(res.skipped.join("|"), /clashes with a CNAME.*IPv4 address/);

  const db = await dbm.getDb();
  const snaps = await db.select().from(dbm.schema.dnsSnapshots).where(eq(dbm.schema.dnsSnapshots.zoneId, zoneId));
  const empty = snaps.find((s) => s.records.length === 0)!;
  assert.ok(empty, "the state before the template was kept");
  const beforeRestore = await records();
  await engine.restoreZoneSnapshot(zoneId, empty.id);
  assert.deepEqual(await records(), []);
  const undo = (await db.select().from(dbm.schema.dnsSnapshots).where(eq(dbm.schema.dnsSnapshots.zoneId, zoneId))).find((s) => s.reason.startsWith("Before restoring"))!;
  await engine.restoreZoneSnapshot(zoneId, undo.id);
  assert.deepEqual(await records(), beforeRestore, "and the restore itself can be undone");
  await assert.rejects(engine.restoreZoneSnapshot(zoneId, "00000000-0000-4000-8000-000000000000"), /Snapshot not found/);
});
