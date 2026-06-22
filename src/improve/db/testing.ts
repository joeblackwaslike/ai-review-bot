import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { newDb } from "pg-mem";
import type { Db } from "./client.js";
import * as schema from "./schema.js";

/** Build an isolated in-memory Postgres (pg-mem) with the full corpus schema
 * applied, wrapped in the same node-postgres Drizzle driver used in production.
 * Each call returns a fresh, independent database. */
export async function createTestDb(): Promise<Db> {
	const mem = newDb();
	applySchema(mem);
	const adapter = mem.adapters.createPg();
	const pool = new adapter.Pool();
	const db = drizzle(pool, { schema }) as unknown as Db;
	return db;
}

function applySchema(mem: ReturnType<typeof newDb>): void {
	const dir = new URL("./migrations", import.meta.url).pathname;
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	for (const file of files) {
		const raw = readFileSync(join(dir, file), "utf8");
		for (const stmt of raw.split("--> statement-breakpoint")) {
			const trimmed = stmt.trim();
			if (trimmed) mem.public.none(trimmed);
		}
	}
}
