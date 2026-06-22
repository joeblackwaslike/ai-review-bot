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

describe.skipIf(!url)("repo (real postgres)", () => {
	let pool: Pool;
	let db: NodePgDatabase<typeof schema>;

	beforeAll(async () => {
		pool = new Pool({ connectionString: url });
		await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
		await pool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
		// Route all DDL/DML at this connection into the test schema so the
		// migration's unqualified table names land there and never collide with
		// other objects in the database.
		await pool.query(`SET search_path TO ${TEST_SCHEMA}`);
		for (const stmt of loadMigrationStatements()) {
			await pool.query(stmt);
		}
		db = drizzle(pool, { schema });
	});

	afterAll(async () => {
		if (pool) {
			await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
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
