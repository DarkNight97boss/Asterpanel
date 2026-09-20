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

test("help search: every word must match, titles outrank bodies, drafts and other sections stay out", async () => {
  const dbm = await import("../src/db");
  const pages = await import("../src/lib/pages");
  const db = await dbm.getDb();
  const text = (t: string) => [{ id: "b", type: "text", props: { body: t } }];
  await db.insert(dbm.schema.pages).values([
    { slug: "help/email-setup", title: "Set up email on your phone", status: "published", excerpt: "IMAP and SMTP settings", blocks: text("Use port 993.") },
    { slug: "help/dns", title: "Point your domain", status: "published", blocks: text("Create an A record. For email see the MX record.") },
    { slug: "help/draft", title: "Email secrets", status: "draft", blocks: [] },
    { slug: "blog/email", title: "Email news", status: "published", blocks: [] },
  ]);
  assert.deepEqual((await pages.searchPages("help/", "email")).map((p) => p.slug), ["help/email-setup", "help/dns"]);
  assert.deepEqual((await pages.searchPages("help/", "EMAIL record!")).map((p) => p.slug), ["help/dns"]);
  assert.deepEqual(await pages.searchPages("help/", "to a of"), [], "only short words: nothing to search");
  assert.deepEqual(await pages.searchPages("", "email"), [], "no section, no search");
  assert.deepEqual(await pages.searchPages("help/", "100% _wild_"), []);
  assert.deepEqual(pages.searchTerms("Il mio sito è lento, lento!"), ["mio", "sito", "lento"]);
});

test("votes: counted on published help articles only", async () => {
  const dbm = await import("../src/db");
  const pages = await import("../src/lib/pages");
  const { eq } = await import("drizzle-orm");
  assert.equal(await pages.votePage("help/", "help/dns", true), true);
  assert.equal(await pages.votePage("help/", "help/dns", false), true);
  assert.equal(await pages.votePage("help/", "help/draft", true), false);
  assert.equal(await pages.votePage("help/", "blog/email", true), false);
  const [row] = await (await dbm.getDb()).select().from(dbm.schema.pages).where(eq(dbm.schema.pages.slug, "help/dns"));
  assert.deepEqual([row.helpfulYes, row.helpfulNo], [1, 1]);
});
