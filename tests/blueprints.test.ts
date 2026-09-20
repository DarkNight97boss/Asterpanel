import assert from "node:assert/strict";
import { before, test } from "node:test";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

import { cleanBlueprint, parseSlugs } from "../src/platform/blueprints";

let dbm: typeof import("../src/db");
let engine: typeof import("../src/platform/engine");
let clientId: string, companyA: string, companyB: string;

before(async () => {
  dbm = await import("../src/db");
  engine = await import("../src/platform/engine");
  const db = await dbm.getDb();
  [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "bp@example.test", passwordHash: "x" }).returning();
  [{ id: companyA }, { id: companyB }] = await db.insert(dbm.schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
  await db.insert(dbm.schema.nodes).values({ name: "bp-node", baseDomain: "n.example.test", tokenHash: "h", lastSeenAt: new Date(), status: "online" });
});

test("slugs: plain, links and duplicates; anything that is not a slug is refused", () => {
  assert.deepEqual(parseSlugs("wordpress-seo, https://wordpress.org/plugins/contact-form-7/\nWordPress-SEO\nhttps://it.wordpress.org/plugins/akismet/"), ["wordpress-seo", "contact-form-7", "akismet"]);
  assert.throws(() => parseSlugs("good-one\n--url=http://evil"), /not a wordpress.org slug/);
  assert.throws(() => parseSlugs("a;rm -rf"), /not a wordpress.org slug/);
});

test("a blueprint is checked field by field", () => {
  assert.deepEqual(cleanBlueprint({ plugins: ["a", "a", "b"], theme: " Astra ", permalinks: "/%postname%/", timezone: "Europe/Rome", hideFromSearch: true }), { plugins: ["a", "b"], theme: "astra", permalinks: "/%postname%/", timezone: "Europe/Rome", hideFromSearch: true });
  assert.throws(() => cleanBlueprint({ plugins: Array.from({ length: 21 }, (_, i) => `p${i}`) }), /at most 20/);
  assert.throws(() => cleanBlueprint({ plugins: [], permalinks: "/%postname%/ --allow-root" }), /permalink/);
  assert.throws(() => cleanBlueprint({ plugins: [], timezone: "Rome; reboot" }), /time zone/);
  assert.throws(() => cleanBlueprint({ plugins: ["../x"] }), /slugs/);
});

test("companies see their own blueprints and the shared ones, never each other's", async () => {
  const a = await engine.saveBlueprint(companyA, { name: "Agency", spec: { plugins: ["wordpress-seo"], theme: "astra" } });
  await engine.saveBlueprint(null, { name: "Shop starter", spec: { plugins: ["woocommerce"] } });
  assert.deepEqual((await engine.listBlueprints(companyA)).map((b) => b.name), ["Agency", "Shop starter"]);
  assert.deepEqual((await engine.listBlueprints(companyB)).map((b) => b.name), ["Shop starter"]);
  await assert.rejects(engine.blueprintFor(companyB, a), /not found/);
  // Nor edit or delete them.
  await assert.rejects(engine.saveBlueprint(companyB, { id: a, name: "Mine now", spec: { plugins: [] } }), /not found/);
  await engine.deleteBlueprint(companyB, a);
  assert.equal((await engine.listBlueprints(companyA)).length, 2);
  await assert.rejects(engine.saveBlueprint(companyA, { name: "Bad", spec: { plugins: ["UPPER case"] } }), /slugs/);
});

test("the new site carries a copy: the agent gets it, and later edits of the blueprint do not reach the site", async () => {
  const [bp] = await engine.listBlueprints(companyA);
  const id = await engine.createWorkload({ clientId, companyId: companyA, type: "wordpress", name: "Blog", config: { adminEmail: "bp@example.test", blueprint: await engine.blueprintFor(companyA, bp.id) } });
  assert.deepEqual((await engine.buildSpec(id)).wordpress?.blueprint, { plugins: ["wordpress-seo"], theme: "astra" });
  await engine.saveBlueprint(companyA, { id: bp.id, name: "Agency", spec: { plugins: ["something-else"] } });
  assert.deepEqual((await engine.buildSpec(id)).wordpress?.blueprint?.plugins, ["wordpress-seo"]);
});
