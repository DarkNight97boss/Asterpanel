import "server-only";
import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

export const getPublishedPage = cache(async (slug: string) => {
  const db = await getDb();
  return db.query.pages.findFirst({ where: and(eq(schema.pages.slug, slug), eq(schema.pages.status, "published")) });
});
