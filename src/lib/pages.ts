import "server-only";
import { cache } from "react";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

export const getPublishedPage = cache(async (slug: string) => {
  const db = await getDb();
  return db.query.pages.findFirst({ where: and(eq(schema.pages.slug, slug), eq(schema.pages.status, "published")) });
});

/**
 * Published pages under an address prefix ("blog/"), newest first. The prefix
 * is mandatory and well-formed: an empty one would list the whole site, drafts'
 * neighbours included.
 */
export async function listPagesByPrefix(rawPrefix: string, limit = 12) {
  const prefix = rawPrefix.trim().toLowerCase().replace(/^\/+/, "");
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*\/$/.test(prefix)) return [];
  const db = await getDb();
  return db
    .select({ slug: schema.pages.slug, title: schema.pages.title, excerpt: schema.pages.excerpt, createdAt: schema.pages.createdAt })
    .from(schema.pages)
    .where(and(eq(schema.pages.status, "published"), like(schema.pages.slug, `${prefix}%`)))
    .orderBy(desc(schema.pages.createdAt))
    .limit(Math.min(100, Math.max(1, Math.round(limit) || 12)));
}

const cleanPrefix = (raw: string) => {
  const prefix = raw.trim().toLowerCase().replace(/^\/+/, "");
  return /^[a-z0-9-]+(\/[a-z0-9-]+)*\/$/.test(prefix) ? prefix : null;
};

/** Words worth searching for: short ones and punctuation only add noise. LIKE wildcards are escaped. */
export const searchTerms = (query: string) => [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))].slice(0, 6);

/**
 * Published pages under a prefix that mention every word of the query, best
 * first: a word in the title counts more than one in the summary, which
 * counts more than one in the body.
 */
export async function searchPages(rawPrefix: string, query: string, limit = 8) {
  const prefix = cleanPrefix(rawPrefix);
  const terms = searchTerms(query);
  if (!prefix || !terms.length) return [];
  const db = await getDb();
  const body = sql`lower(${schema.pages.blocks}::text)`;
  const has = (column: unknown, term: string) => sql`position(${term} in ${column}) > 0`;
  const title = sql`lower(${schema.pages.title})`;
  const excerpt = sql`lower(${schema.pages.excerpt})`;
  const everyTerm = terms.map((term) => sql`(${has(title, term)} or ${has(excerpt, term)} or ${has(body, term)})`);
  const score = sql.join(terms.map((term) => sql`(case when ${has(title, term)} then 5 else 0 end + case when ${has(excerpt, term)} then 2 else 0 end)`), sql` + `);
  return db
    .select({ slug: schema.pages.slug, title: schema.pages.title, excerpt: schema.pages.excerpt })
    .from(schema.pages)
    .where(and(eq(schema.pages.status, "published"), like(schema.pages.slug, `${prefix}%`), ...everyTerm))
    .orderBy(sql`${score} desc`, desc(schema.pages.helpfulYes), desc(schema.pages.createdAt))
    .limit(Math.min(20, Math.max(1, limit)));
}

/** One answer to "Was this helpful?" on a published page under the help prefix. */
export async function votePage(rawPrefix: string, slug: string, helpful: boolean): Promise<boolean> {
  const prefix = cleanPrefix(rawPrefix);
  if (!prefix || !slug.startsWith(prefix)) return false;
  const column = helpful ? schema.pages.helpfulYes : schema.pages.helpfulNo;
  const [row] = await (await getDb()).update(schema.pages).set(helpful ? { helpfulYes: sql`${column} + 1` } : { helpfulNo: sql`${column} + 1` }).where(and(eq(schema.pages.slug, slug), eq(schema.pages.status, "published"))).returning({ id: schema.pages.id });
  return !!row;
}
