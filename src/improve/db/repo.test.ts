import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { baseFinding, baseRaw } from "./repo.fixtures.js";
import { insertRawFeedback, upsertFinding } from "./repo.js";
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
