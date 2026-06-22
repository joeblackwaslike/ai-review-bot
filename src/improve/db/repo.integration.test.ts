import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrationStatements } from "./migrate.js";
import { baseFinding, baseRaw } from "./repo.fixtures.js";
import { insertRawFeedback, upsertFinding } from "./repo.js";
import * as schema from "./schema.js";

/** Real-Postgres integration coverage for the idempotency guarantees pg-mem
 * cannot reproduce (chiefly `ON CONFLICT DO NOTHING` returning the empty set).
 * Skipped unless DATABASE_URL_TEST points at a disposable Postgres — dedup is
 * load-bearing, so it must be verified against genuine Postgres semantics, not
 * a shim. Runs in an isolated `ai_review_corpus_test` schema it owns end-to-end
 * (dropped + recreated up front, dropped again on teardown) so it never touches
 * other data in the target database. */

const url = process.env.DATABASE_URL_TEST;
const TEST_SCHEMA = "ai_review_corpus_test";

/** The seven enum types the migration declares. drizzle hard-codes
 * `"public".` qualifiers on `CREATE TYPE`, so a connection-level search_path
 * alone won't redirect them — we defensively drop them in `public` before each
 * run so repeated runs against the same database don't fail with
 * `type ... already exists`. */
const ENUM_TYPES = [
	"feedback_intent",
	"feedback_source",
	"proposal_kind",
	"proposal_status",
	"provider",
	"qc_trigger",
	"trend_kind",
];

describe.skipIf(!url)("repo (real postgres)", () => {
	let pool: Pool;
	let db: NodePgDatabase<typeof schema>;

	beforeAll(async () => {
		// Pin search_path at the connection level (every pooled connection
		// inherits it via the libpq `options` parameter) so the migration's
		// unqualified table names land in the test schema regardless of which
		// physical connection the pool hands out.
		pool = new Pool({
			connectionString: url,
			options: `-c search_path=${TEST_SCHEMA}`,
		});
		await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
		// Belt-and-suspenders: the schema CASCADE drop won't remove the
		// public-qualified enums drizzle creates, so drop those explicitly too.
		// No CASCADE here: the schema drop above already removed the dependent
		// test tables, so the enums have no remaining dependents and a plain
		// DROP TYPE succeeds — and we never risk CASCADE removing unrelated
		// objects if DATABASE_URL_TEST ever points at a non-disposable DB.
		for (const t of ENUM_TYPES) {
			await pool.query(`DROP TYPE IF EXISTS public.${t}`);
		}
		await pool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
		for (const stmt of loadMigrationStatements()) {
			await pool.query(stmt);
		}
		db = drizzle(pool, { schema });
	});

	afterAll(async () => {
		if (pool) {
			await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
			// Plain DROP TYPE (no CASCADE): dependents are gone with the schema.
			for (const t of ENUM_TYPES) {
				await pool.query(`DROP TYPE IF EXISTS public.${t}`);
			}
			await pool.end();
		}
	});

	it("insertRawFeedback returns 0 on duplicate dedup_key (ON CONFLICT DO NOTHING)", async () => {
		const first = await insertRawFeedback(db, baseRaw);
		expect(first).toBe(1);
		const second = await insertRawFeedback(db, baseRaw);
		expect(second).toBe(0);
	});

	it("upsertFinding keeps a stable id on natural_key conflict", async () => {
		const id1 = await upsertFinding(db, baseFinding);
		const id2 = await upsertFinding(db, { ...baseFinding, severity: "medium" });
		expect(id2).toBe(id1);
	});
});
