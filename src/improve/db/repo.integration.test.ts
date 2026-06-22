import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrationStatements } from "./migrate.js";
import { baseFinding, baseRaw } from "./repo.fixtures.js";
import { insertRawFeedback, upsertFinding } from "./repo.js";
import * as schema from "./schema.js";

/** Real-Postgres integration coverage for the idempotency guarantees pg-mem
 * cannot reproduce (chiefly `ON CONFLICT DO NOTHING` returning the empty set).
 * Skipped unless DATABASE_URL_TEST points at a Postgres — dedup is load-bearing,
 * so it must be verified against genuine Postgres semantics, not a shim.
 *
 * Isolation model: the entire generated migration is rewritten into a dedicated
 * `ai_review_corpus_test` schema before it runs — every `"public".` qualifier
 * (the `CREATE TYPE` enums and the FK `REFERENCES`) is rewritten to the test
 * schema, and the connection-level `search_path` routes the migration's
 * unqualified table creates and enum-column references there too. On teardown
 * the whole schema is dropped wholesale (`DROP SCHEMA ... CASCADE`). The test
 * therefore never creates or drops anything in `public`, so it is safe to run
 * against any database (still gated on DATABASE_URL_TEST). */

const url = process.env.DATABASE_URL_TEST;
const TEST_SCHEMA = "ai_review_corpus_test";

describe.skipIf(!url)("repo (real postgres)", () => {
	let pool: Pool;
	let db: NodePgDatabase<typeof schema>;

	beforeAll(async () => {
		// Pin search_path at the connection level (every pooled connection
		// inherits it via the libpq `options` parameter) so the migration's
		// unqualified table names and enum-column references land in the test
		// schema regardless of which physical connection the pool hands out.
		pool = new Pool({
			connectionString: url,
			options: `-c search_path=${TEST_SCHEMA}`,
		});
		await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
		await pool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
		for (const stmt of loadMigrationStatements()) {
			// Redirect the migration's hard-coded `"public".` qualifiers (enums +
			// FK REFERENCES) into the isolated test schema so nothing touches public.
			await pool.query(stmt.replaceAll('"public".', `"${TEST_SCHEMA}".`));
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
