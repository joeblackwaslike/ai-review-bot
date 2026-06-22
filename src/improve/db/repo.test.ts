import { describe, expect, it } from "vitest";
import { insertRawFeedback, upsertFinding } from "./repo.js";
import { createTestDb } from "./testing.js";

const baseRaw = {
	source: "inline_reaction" as const,
	provider: "anthropic" as const,
	owner: "joeblackwaslike",
	repo: "ai-review-bot",
	pr: 7,
	commentId: 111,
	reviewId: null,
	inReplyToId: null,
	path: "src/a.ts",
	line: 4,
	skills: ["code-reviewer.md"],
	title: "Null deref",
	verdict: "down",
	actor: "octocat",
	body: null,
	eventAt: new Date("2026-06-21T00:00:00Z"),
	dedupKey: "react:inline_reaction:111:octocat:down",
};

const baseFinding = {
	provider: "anthropic" as const,
	owner: "joeblackwaslike",
	repo: "ai-review-bot",
	pr: 7,
	commentId: 111,
	reviewId: null,
	path: "src/a.ts",
	line: 4,
	skills: ["code-reviewer.md"],
	title: "Null deref",
	severity: "high",
	headSha: "abc123",
	postedAt: new Date("2026-06-21T00:00:00Z"),
	naturalKey: "anthropic:joeblackwaslike/ai-review-bot#7:src/a.ts:4:deadbeef",
};

describe("insertRawFeedback", () => {
	it("inserts a row", async () => {
		const db = await createTestDb();
		const inserted = await insertRawFeedback(db, baseRaw);
		expect(inserted).toBe(1);
	});

	it("is idempotent on dedup_key (ON CONFLICT DO NOTHING)", async () => {
		const db = await createTestDb();
		await insertRawFeedback(db, baseRaw);
		const second = await insertRawFeedback(db, baseRaw);
		expect(second).toBe(0);
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
