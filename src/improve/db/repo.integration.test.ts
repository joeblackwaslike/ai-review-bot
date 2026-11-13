import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrationStatements } from "./migrate.js";
import { baseFinding, baseRaw } from "./repo.fixtures.js";
import {
	insertDiscards,
	insertRawFeedback,
	listFindingsForPr,
	listUnclassifiedBundles,
	upsertFinding,
} from "./repo.js";
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

	it("insertDiscards inserts 0 rows on a duplicate unique key", async () => {
		const row = {
			reviewer: "claude",
			owner: "o",
			repo: "r",
			pr: 1,
			reviewSha: "abc",
			reason: "CAP" as const,
			code: null,
			disposition: "dropped" as const,
			naturalKey: "k1",
			path: null,
			line: null,
			severity: null,
			title: "t",
			skill: null,
		};
		expect(await insertDiscards(db, [row])).toBe(1);
		expect(await insertDiscards(db, [row])).toBe(0);
	});

	it("insertDiscards inserts one row per skill and none for a repeat", async () => {
		const row = {
			reviewer: "claude",
			owner: "o",
			repo: "r",
			pr: 2,
			reviewSha: "def",
			reason: "SUPPRESSED_SETTLED" as const,
			code: null,
			disposition: "dropped" as const,
			naturalKey: "k2",
			path: "src/a.ts",
			line: 4,
			severity: "P2",
			title: "t",
			skill: "a.md",
		};
		const rows = ["a.md", "b.md", "c.md", "d.md", null].map((skill) => ({
			...row,
			skill,
		}));
		expect(await insertDiscards(db, rows)).toBe(5);
		expect(await insertDiscards(db, [row])).toBe(0);
		expect(await insertDiscards(db, [{ ...row, skill: null }])).toBe(0);
	});

	it("insertDiscards inserts one row per line and none for a repeat", async () => {
		const row = {
			reviewer: "claude",
			owner: "o",
			repo: "r",
			pr: 3,
			reviewSha: "fed",
			reason: "OFF_DIFF" as const,
			code: "OFF_DIFF_LINE" as const,
			disposition: "dropped" as const,
			naturalKey: "k3",
			path: "src/x.ts",
			line: 20,
			severity: "P2",
			title: "Missing error handling",
			skill: "a.md",
		};
		const rows = [20, 200, null].map((line) => ({ ...row, line }));
		expect(await insertDiscards(db, rows)).toBe(3);
		expect(await insertDiscards(db, [row])).toBe(0);
		expect(await insertDiscards(db, [{ ...row, line: null }])).toBe(0);
	});

	it("persists a custom reviewer and reads it back", async () => {
		await upsertFinding(db, {
			...baseFinding,
			reviewer: "gemini",
			pr: 9,
			naturalKey: "k-gemini-9",
		});
		await upsertFinding(db, {
			...baseFinding,
			reviewer: "codex",
			pr: 9,
			naturalKey: "k-codex-9",
		});
		const rows = await listFindingsForPr(
			db,
			baseFinding.owner,
			baseFinding.repo,
			9,
		);
		expect(rows.map((r) => r.reviewer)).toEqual(["gemini", "codex"]);
	});

	it("upsertFinding keeps a stable id on natural_key conflict", async () => {
		const id1 = await upsertFinding(db, baseFinding);
		const id2 = await upsertFinding(db, { ...baseFinding, severity: "medium" });
		expect(id2).toBe(id1);
	});

	// listUnclassifiedBundles's lateral-join query is not pg-mem compatible (a
	// parser limitation, not a logic bug — same crash with or without this
	// fix), so this pr_comment coverage lives here rather than in repo.test.ts.
	// Flagged by chatgpt-codex-connector on this PR's own review: a pr_comment
	// row has no reply thread to aggregate replyBody from, so without the
	// COALESCE fallback in the query it reaches the classifier with an empty
	// prompt — the captured free text is written but never actually read.
	it("listUnclassifiedBundles surfaces a pr_comment's own body as replyBody", async () => {
		await insertRawFeedback(db, {
			...baseRaw,
			source: "pr_comment",
			commentId: 300,
			inReplyToId: null,
			path: null,
			line: null,
			verdict: null,
			body: "this finding looks wrong to me",
			dedupKey: "cmt:pr_comment:300",
		});

		const bundles = await listUnclassifiedBundles(db, 10);

		const bundle = bundles.find((b) => b.replyBody !== null);
		expect(bundle).toMatchObject({
			replyBody: "this finding looks wrong to me",
			findingId: null,
		});
	});

	// inline_reply keeps its existing path — aggregated via the thread lateral,
	// not the pr_comment fallback — so the fix must not change its behavior.
	it("listUnclassifiedBundles still aggregates inline_reply bodies via the thread", async () => {
		await upsertFinding(db, baseFinding);
		await insertRawFeedback(db, {
			...baseRaw,
			source: "inline_reply",
			commentId: 401,
			inReplyToId: baseRaw.commentId,
			verdict: null,
			body: "false positive because X",
			dedupKey: "cmt:inline_reply:401",
		});

		const bundles = await listUnclassifiedBundles(db, 10);

		const bundle = bundles.find(
			(b) => b.replyBody === "false positive because X",
		);
		expect(bundle).toBeDefined();
	});
});
