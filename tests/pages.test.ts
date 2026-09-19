import assert from "node:assert/strict";
import { test } from "node:test";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

test("page lists: only published pages under a real prefix, newest first", async () => {
  const dbm = await import("../src/db");
  const { listPagesByPrefix } = await import("../src/lib/pages");
  const db = await dbm.getDb();
  const at = (d: number) => new Date(Date.UTC(2026, 8, d));
  await db.insert(dbm.schema.pages).values([
    { slug: "blog/first", title: "First", status: "published", excerpt: "One", createdAt: at(1) },
    { slug: "blog/second", title: "Second", status: "published", createdAt: at(5) },
    { slug: "blog/secret-draft", title: "Draft", status: "draft", createdAt: at(9) },
    { slug: "blogroll", title: "Not a post", status: "published", createdAt: at(9) },
    { slug: "help/billing/refunds", title: "Refunds", status: "published", createdAt: at(2) },
    { slug: "pricing", title: "Pricing", status: "published", createdAt: at(3) },
  ]);
  assert.deepEqual((await listPagesByPrefix("blog/")).map((p) => p.title), ["Second", "First"]);
  assert.deepEqual((await listPagesByPrefix("/Help/")).map((p) => p.slug), ["help/billing/refunds"]);
  assert.deepEqual((await listPagesByPrefix("blog/", 1)).map((p) => p.title), ["Second"]);
  for (const bad of ["", "/", "blog", "%", "blog/%", "../admin/", "b_g/"]) assert.deepEqual(await listPagesByPrefix(bad), [], JSON.stringify(bad));
});
