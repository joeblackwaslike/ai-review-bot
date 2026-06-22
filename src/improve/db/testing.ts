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
	patchPool(pool);
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

/** pg-mem compatibility shim for drizzle-orm/node-postgres queries.
 *
 * Two pg-mem limitations to work around:
 * 1. `rowMode: "array"` is unsupported — drizzle uses it for field-mapped
 *    queries. We strip it and convert object rows → arrays using column names
 *    parsed from the RETURNING clause.
 * 2. `ON CONFLICT DO NOTHING RETURNING` returns the existing row instead of the
 *    empty set that real Postgres yields. We detect the conflict case by checking
 *    whether the table row-count changed after the INSERT and return [] if not.
 */
function patchPool(pool: {
	query: (...args: unknown[]) => Promise<unknown>;
}): void {
	const origQuery = (
		pool.query as (...args: unknown[]) => Promise<PgMemResult>
	).bind(pool);

	// biome-ignore lint/suspicious/noExplicitAny: pool patch works with any query shape
	pool.query = async (query: any, values?: unknown): Promise<PgMemResult> => {
		if (!query || typeof query !== "object") {
			return origQuery(query, values);
		}

		const wasArrayMode = query.rowMode === "array";
		const isDoNothing = /do nothing/i.test(String(query.text ?? ""));
		const returningCols = wasArrayMode
			? parseReturningCols(String(query.text ?? ""))
			: null;

		const {
			rowMode: _rm,
			types: _t,
			...rest
		} = query as Record<string, unknown>;
		const cleanQuery: Record<string, unknown> = rest;

		if (Array.isArray(values) && values.length > 0) {
			cleanQuery.values = values;
			values = undefined;
		}

		if (wasArrayMode && isDoNothing && returningCols) {
			const tableMatch = String(query.text ?? "").match(
				/insert into "([^"]+)"/i,
			);
			if (tableMatch) {
				const tableName = tableMatch[1];
				const before = await countRows(origQuery, tableName);
				const result = await origQuery(cleanQuery);
				const after = await countRows(origQuery, tableName);
				if (after === before) {
					result.rows = [];
					return result;
				}
				if (result.rows.length > 0 && !Array.isArray(result.rows[0])) {
					result.rows = result.rows.map((row) =>
						returningCols.map((col) => (row as Record<string, unknown>)[col]),
					);
				}
				return result;
			}
		}

		const result = await origQuery(cleanQuery, values);

		if (
			wasArrayMode &&
			returningCols &&
			result.rows.length > 0 &&
			!Array.isArray(result.rows[0])
		) {
			result.rows = result.rows.map((row) =>
				returningCols.map((col) => (row as Record<string, unknown>)[col]),
			);
		}
		return result;
	};
}

interface PgMemResult {
	rows: unknown[];
	rowCount: number;
	command: string;
}

async function countRows(
	query: (...args: unknown[]) => Promise<PgMemResult>,
	tableName: string,
): Promise<number> {
	const r = await query({ text: `SELECT COUNT(*) as c FROM "${tableName}"` });
	return Number((r.rows[0] as Record<string, unknown>).c);
}

function parseReturningCols(sql: string): string[] | null {
	const m = sql.match(/returning\s+(.+)$/i);
	if (!m) return null;
	return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
