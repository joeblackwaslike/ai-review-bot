import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let db: Db | null = null;

/** Lazily build a pooled Drizzle client over the Neon POOLED connection string.
 * Singleton so concurrent cron/webhook/dashboard invocations on a warm instance
 * share one pool (mirrors the kvSingleton pattern). */
export function getDb(): Db {
	if (db) return db;
	const url = process.env.DATABASE_URL;
	if (!url) {
		throw new Error("DATABASE_URL is required for the improvement-loop corpus");
	}
	pool = new Pool({ connectionString: url });
	db = drizzle(pool, { schema });
	return db;
}

/** Drop the cached client (call after a transient connection error so the next
 * call rebuilds it, and to isolate tests). */
export function resetDbSingleton(): void {
	pool?.end().catch(() => {});
	pool = null;
	db = null;
}
