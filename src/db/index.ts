import "server-only";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * One database handle for the whole app.
 *
 * - `DATABASE_URL` set   → real PostgreSQL through postgres.js (production).
 * - `DATABASE_URL` unset → embedded PGlite persisted under `.data/` so the
 *   project runs with zero external services (development, demos, tests).
 *
 * Both speak the same SQL dialect, so the rest of the code never branches.
 * Migrations in `./drizzle` are applied automatically on first connection.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS = path.join(process.cwd(), "drizzle");

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const db = drizzle(postgres(url, { max: 10, onnotice: () => {} }), { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return db as unknown as Db;
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  if (dir !== "memory://") mkdirSync(dir, { recursive: true });
  const db = drizzle(new PGlite(dir), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as Db;
}

// Survive dev-server hot reloads: a second PGlite instance on the same
// directory would corrupt it.
const globalForDb = globalThis as unknown as { __asterDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  globalForDb.__asterDb ??= connect().catch((err) => {
    globalForDb.__asterDb = undefined;
    throw err;
  });
  return globalForDb.__asterDb;
}

export { schema };
