import { drizzle } from "drizzle-orm/node-postgres";
import { newDb } from "pg-mem";
import type { Db } from "./client.js";
import { loadMigrationStatements } from "./migrate.js";
import * as schema from "./schema.js";

/** Build an isolated in-memory Postgres (pg-mem) with the full corpus schema
 * applied, wrapped in the same node-postgres Drizzle driver used in production.
 * Each call returns a fresh, independent database.
 *
 * NOTE: pg-mem is only used for tests that don't depend on Postgres semantics
 * pg-mem gets wrong. In particular it returns the existing row (not the empty
 * set real Postgres yields) for `ON CONFLICT DO NOTHING ... RETURNING`, so the
 * DO-NOTHING idempotency path is covered by the real-Postgres integration test
 * (`repo.integration.test.ts`), NOT here. */
export async function createTestDb(): Promise<Db> {
	const mem = newDb();
	for (const stmt of loadMigrationStatements()) {
		mem.public.none(stmt);
	}
	const adapter = mem.adapters.createPg();
	const pool = new adapter.Pool();
	patchPool(pool);
	const db = drizzle(pool, { schema }) as unknown as Db;
	return db;
}

interface PgMemResult {
	rows: unknown[];
	rowCount: number;
	command: string;
}

/** Minimal driver-plumbing shim so drizzle-orm/node-postgres can run on
 * pg-mem at all. It does NOT reimplement any SQL/Postgres semantics — every
 * transform here only translates the shapes drizzle's pg driver emits into the
 * shapes pg-mem's adapter accepts, then translates the result rows back:
 *
 * 1. Strip `types` — drizzle always attaches a `types.getTypeParser`, which
 *    pg-mem's adapter explicitly rejects with "getTypeParser is not supported".
 * 2. Strip `rowMode: "array"` — pg-mem rejects it ("pg rowMode"); drizzle sets
 *    it for field-mapped queries and then expects each row as a positional
 *    array, so we (4) convert pg-mem's object rows back into arrays.
 * 3. Move 2nd-arg `values` into `query.values` — drizzle passes bound params as
 *    the second argument, but pg-mem only reads them off the query object.
 * 4. Convert object rows → positional arrays for the queries that asked for
 *    array mode, using the column order parsed from the RETURNING clause. */
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

function parseReturningCols(sql: string): string[] | null {
	const m = sql.match(/returning\s+(.+)$/i);
	if (!m) return null;
	return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
