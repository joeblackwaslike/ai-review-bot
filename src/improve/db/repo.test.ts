import { describe, expect, it } from "vitest";
import { baseFinding, baseRaw } from "./repo.fixtures.js";
import { insertRawFeedback, upsertFinding } from "./repo.js";
import { createTestDb } from "./testing.js";

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
});
