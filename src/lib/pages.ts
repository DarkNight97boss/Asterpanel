import "server-only";
import { cache } from "react";
import { and, desc, eq, like } from "drizzle-orm";
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
