import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { loadMigrationStatements } from "./migrate.js";
import { baseFinding, baseRaw } from "./repo.fixtures.js";
import {
	type DiscardInsert,
	identityColumns,
	insertDiscards,
	insertRawFeedback,
	listFindingsForPr,
	upsertFinding,
} from "./repo.js";
import { createTestDb } from "./testing.js";

interface FindingRow {
	skills: string[];
	backfilled: boolean;
	posted_at: string;
	comment_id: number | null;
}

/** Read the single catalog row back as raw columns. `db.select()` is unusable
 * on the pg-mem harness — its driver shim only reconstructs column order from a
 * RETURNING clause — so the merge assertions go through raw SQL instead. */
async function readFinding(db: Db): Promise<FindingRow> {
	const result = await db.execute(
		sql`select skills, backfilled, posted_at, comment_id from finding_catalog`,
	);
	return (result.rows as unknown as FindingRow[])[0];
}

// These assertions only cover behavior pg-mem reproduces faithfully. The
// `insertRawFeedback` ON CONFLICT DO NOTHING idempotency path (returning 0 on a
// duplicate dedup_key) is NOT asserted here because pg-mem returns the existing
// row for `DO NOTHING ... RETURNING` instead of the empty set real Postgres
// yields — it is covered against real Postgres in `repo.integration.test.ts`.

describe("insertRawFeedback", () => {
	it("inserts a row", async () => {
		const db = await createTestDb();
		const inserted = await insertRawFeedback(db, baseRaw);
		expect(inserted).toBe(1);
	});
});

describe("upsertFinding", () => {
	it("inserts then updates the same natural_key without duplicating", async () => {
		const db = await createTestDb();
		const id1 = await upsertFinding(db, baseFinding);
		const id2 = await upsertFinding(db, { ...baseFinding, severity: "medium" });
		expect(id2).toBe(id1);
	});

	// The same finding can arrive from live capture (real skills) and from the
	// historical backfill (no skills) in either order, so the merge must not let
	// whichever pass runs second degrade what the first recorded.
	describe("merging a live capture with a backfill", () => {
		const live = { ...baseFinding, skills: ["code-reviewer.md"] };
		const backfilled = {
			...baseFinding,
			skills: [],
			backfilled: true,
			commentId: null,
		};

		it("keeps live skills when the backfill lands second", async () => {
			const db = await createTestDb();
			await upsertFinding(db, live);
			await upsertFinding(db, backfilled);
			const row = await readFinding(db);
			expect(row.skills).toEqual(["code-reviewer.md"]);
		});

		it("adopts live skills when the backfill landed first", async () => {
			const db = await createTestDb();
			await upsertFinding(db, backfilled);
			await upsertFinding(db, live);
			const row = await readFinding(db);
			expect(row.skills).toEqual(["code-reviewer.md"]);
		});

		it("clears the backfilled flag once a live capture has seen the row", async () => {
			const db = await createTestDb();
			await upsertFinding(db, backfilled);
			expect((await readFinding(db)).backfilled).toBe(true);
			await upsertFinding(db, live);
			expect((await readFinding(db)).backfilled).toBe(false);
		});

		it("stays backfilled while only backfills have seen the row", async () => {
			const db = await createTestDb();
			await upsertFinding(db, backfilled);
			await upsertFinding(db, backfilled);
			expect((await readFinding(db)).backfilled).toBe(true);
		});

		it("keeps the earliest posted_at rather than the latest write", async () => {
			const db = await createTestDb();
			const early = new Date("2026-06-01T00:00:00Z");
			const late = new Date("2026-07-01T00:00:00Z");
			await upsertFinding(db, { ...baseFinding, postedAt: late });
			await upsertFinding(db, { ...baseFinding, postedAt: early });
			const row = await readFinding(db);
			expect(new Date(row.posted_at).toISOString()).toBe(early.toISOString());
		});

		it("does not let a null comment_id erase a known one", async () => {
			const db = await createTestDb();
			await upsertFinding(db, { ...baseFinding, commentId: 4242 });
			await upsertFinding(db, { ...baseFinding, commentId: null });
			const row = await readFinding(db);
			expect(Number(row.comment_id)).toBe(4242);
		});
	});
});

const baseDiscard: DiscardInsert = {
	provider: "anthropic",
	owner: "o",
	repo: "r",
	pr: 1,
	reviewSha: "abc",
	reason: "CAP",
	code: null,
	disposition: "dropped",
	naturalKey: "k1",
	path: "src/a.ts",
	line: 3,
	severity: "P2",
	title: "t",
	skill: "code-reviewer",
};

describe("insertDiscards", () => {
	it("inserts rows and reads them back", async () => {
		const db = await createTestDb();
		const n = await insertDiscards(db, [
			baseDiscard,
			{
				...baseDiscard,
				naturalKey: "k2",
				reason: "OFF_DIFF",
				code: "BAD_RANGE",
			},
		]);
		expect(n).toBe(2);
		const r = await db.execute(
			sql`select reason, disposition, skill from finding_discards order by natural_key`,
		);
		expect(r.rows).toEqual([
			{ reason: "CAP", disposition: "dropped", skill: "code-reviewer" },
			{ reason: "OFF_DIFF", disposition: "dropped", skill: "code-reviewer" },
		]);
	});

	it("round-trips null skill, path and line", async () => {
		const db = await createTestDb();
		await insertDiscards(db, [
			{ ...baseDiscard, skill: null, path: null, line: null },
		]);
		const r = await db.execute(
			sql`select skill, path, line from finding_discards`,
		);
		expect(r.rows).toEqual([{ skill: null, path: null, line: null }]);
	});

	it("inserts 5 rows for 5 distinct skills, including one null skill", async () => {
		const db = await createTestDb();
		await insertDiscards(
			db,
			["a.md", "b.md", "c.md", "d.md", null].map((skill) => ({
				...baseDiscard,
				skill,
			})),
		);
		const r = await db.execute(
			sql`select count(*)::int as n from finding_discards`,
		);
		expect(r.rows).toEqual([{ n: 5 }]);
	});

	it("inserts 3 rows for rows differing only in line, including a null line", async () => {
		const db = await createTestDb();
		await insertDiscards(
			db,
			[20, 200, null].map((line) => ({ ...baseDiscard, line })),
		);
		const r = await db.execute(
			sql`select count(*)::int as n from finding_discards`,
		);
		expect(r.rows).toEqual([{ n: 3 }]);
	});

	it("returns 0 for an empty batch", async () => {
		const db = await createTestDb();
		expect(await insertDiscards(db, [])).toBe(0);
	});
});

describe("reviewer identity columns", () => {
	it("identityColumns maps claude and codex to the legacy provider and passes other ids through", () => {
		expect(identityColumns("claude")).toEqual({
			reviewer: "claude",
			provider: "anthropic",
		});
		expect(identityColumns("codex")).toEqual({
			reviewer: "codex",
			provider: "openai",
		});
		expect(identityColumns("gemini")).toEqual({
			reviewer: "gemini",
			provider: "gemini",
		});
	});

	it("new writes store reviewer and the legacy provider", async () => {
		const db = await createTestDb();
		await upsertFinding(db, {
			...baseFinding,
			...identityColumns("claude"),
			naturalKey: "k-claude",
		});
		await upsertFinding(db, {
			...baseFinding,
			...identityColumns("gemini"),
			naturalKey: "k-gemini",
		});
		const r = await db.execute(
			sql`select reviewer, provider from finding_catalog order by natural_key`,
		);
		expect(r.rows).toEqual([
			{ reviewer: "claude", provider: "anthropic" },
			{ reviewer: "gemini", provider: "gemini" },
		]);
	});

	it("provider accepts a value outside the old enum", async () => {
		const db = await createTestDb();
		const inserted = await insertRawFeedback(db, {
			...baseRaw,
			...identityColumns("gemini"),
		});
		expect(inserted).toBe(1);
	});

	it("an old-shape row inserted after the backfill (provider only, reviewer NULL) is read back as claude", async () => {
		const db = await createTestDb();
		await upsertFinding(db, { ...baseFinding, provider: "anthropic" });
		const raw = await db.execute(sql`select reviewer from finding_catalog`);
		expect(raw.rows).toEqual([{ reviewer: null }]);
		const rows = await listFindingsForPr(
			db,
			baseFinding.owner,
			baseFinding.repo,
			baseFinding.pr,
		);
		expect(rows.map((r) => r.reviewer)).toEqual(["claude"]);
	});

	it("reads map an old-shape openai row to codex and keep an old-shape custom provider as is", async () => {
		const db = await createTestDb();
		await upsertFinding(db, {
			...baseFinding,
			provider: "openai",
			naturalKey: "k1",
		});
		await upsertFinding(db, {
			...baseFinding,
			provider: "gemini",
			naturalKey: "k2",
		});
		const rows = await listFindingsForPr(
			db,
			baseFinding.owner,
			baseFinding.repo,
			baseFinding.pr,
		);
		expect(rows.map((r) => r.reviewer)).toEqual(["codex", "gemini"]);
	});

	it("backfill statements set reviewer on pre-existing rows", async () => {
		const db = await createTestDb();
		for (const [i, provider] of ["anthropic", "openai", "gemini"].entries()) {
			await db.execute(sql`
				insert into finding_catalog
				  (provider, owner, repo, pr, skills, title, head_sha, posted_at, natural_key)
				values
				  (${provider}, 'o', 'r', 1, '{}', 't', 'sha', now(), ${`nk${i}`})
			`);
			await db.execute(sql`
				insert into raw_feedback
				  (source, provider, owner, repo, pr, actor, event_at, dedup_key)
				values
				  ('inline_reaction', ${provider}, 'o', 'r', 1, 'a', now(), ${`dk${i}`})
			`);
		}
		for (const stmt of loadMigrationStatements().filter((s) =>
			/^UPDATE/i.test(s),
		)) {
			await db.execute(sql.raw(stmt));
		}
		for (const table of ["finding_catalog", "raw_feedback"]) {
			const r = await db.execute(
				sql.raw(`select provider, reviewer from ${table} order by id`),
			);
			expect(r.rows).toEqual([
				{ provider: "anthropic", reviewer: "claude" },
				{ provider: "openai", reviewer: "codex" },
				{ provider: "gemini", reviewer: "gemini" },
			]);
		}
	});

	it("keeps the legacy provider enum type after the expand migration", async () => {
		const db = await createTestDb();
		const r = await db.execute(sql`select 'anthropic'::provider as p`);
		expect(r.rows).toEqual([{ p: "anthropic" }]);
	});

	it("discards: the same reviewer twice yields one row, and a second reviewer with a different natural key yields a second row", async () => {
		const db = await createTestDb();
		const row = { ...baseDiscard, provider: "shared" };
		await insertDiscards(db, [{ ...row, reviewer: "alpha" }]);
		await insertDiscards(db, [{ ...row, reviewer: "alpha" }]);
		let r = await db.execute(
			sql`select count(*)::int as n from finding_discards`,
		);
		expect(r.rows).toEqual([{ n: 1 }]);
		await insertDiscards(db, [{ ...row, reviewer: "beta", naturalKey: "k9" }]);
		r = await db.execute(sql`select count(*)::int as n from finding_discards`);
		expect(r.rows).toEqual([{ n: 2 }]);
	});
});
