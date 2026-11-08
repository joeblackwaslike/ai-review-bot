import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Label, PostedClaim } from "../types.js";
import { selectItems } from "./select.js";

const claim = (id: string, over: Partial<PostedClaim> = {}): PostedClaim => ({
	id,
	roundIndex: 0,
	reviewId: 1,
	source: "inline",
	commentId: 10,
	path: "src/a.ts",
	line: 5,
	severity: "P2",
	title: `title ${id}`,
	text: `text ${id}`,
	...over,
});

const write = (
	dir: string,
	id: string,
	provider: string,
	claims: PostedClaim[],
	labels: { claimId: string; label: Label; confirmed: boolean }[],
) => {
	writeFileSync(
		join(dir, `${id}.json`),
		JSON.stringify({
			schemaVersion: 1,
			owner: "o",
			repo: "r",
			pull: 5,
			provider,
			author: "joe",
			recordedAt: "2026-11-01T00:00:00Z",
			rounds: [
				{
					index: 0,
					reviewId: 1,
					provider,
					submittedAt: "2026-11-01T00:00:00Z",
					headSha: "head-sha",
					baseSha: "base-sha",
					mergeBase: null,
					triggerAt: null,
					approximate: false,
					commitsSince: [],
					claims,
				},
			],
			threads: [],
			reactions: [],
		}),
	);
	writeFileSync(
		join(dir, `${id}.labels.json`),
		JSON.stringify({
			fixtureId: id,
			provisional: false,
			labels: labels.map((l) => ({ ...l, confidence: "high", evidence: [] })),
			repeatPairs: [],
			negativePairs: [],
			allowedSuppression: [],
		}),
	);
};

const setup = () => mkdtempSync(join(tmpdir(), "verifier-select-"));

describe("selectItems", () => {
	it("keeps fixed and rejected claims with the round's head sha and the fixture's producer", () => {
		const dir = setup();
		write(
			dir,
			"o__r__5__anthropic",
			"anthropic",
			[claim("a"), claim("b", { severity: "P1" })],
			[
				{ claimId: "a", label: "fixed", confirmed: true },
				{ claimId: "b", label: "rejected", confirmed: false },
			],
		);
		const { items } = selectItems(dir);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			id: "o__r__5__anthropic:a",
			producer: "anthropic",
			label: "fixed",
			confirmed: true,
			owner: "o",
			repo: "r",
			headSha: "head-sha",
			path: "src/a.ts",
			severity: "P2",
		});
		expect(items[1]).toMatchObject({ label: "rejected", confirmed: false });
	});

	it("leaves out deferred and unadjudicated labels and counts them", () => {
		const dir = setup();
		write(
			dir,
			"o__r__5__openai",
			"openai",
			[claim("a"), claim("b"), claim("c")],
			[
				{ claimId: "a", label: "fixed", confirmed: true },
				{ claimId: "b", label: "deferred", confirmed: true },
				{ claimId: "c", label: "unadjudicated", confirmed: false },
			],
		);
		const { items, skipped } = selectItems(dir);
		expect(items.map((i) => i.id)).toEqual(["o__r__5__openai:a"]);
		expect(skipped).toMatchObject({ notFixedOrRejected: 2 });
	});

	it("skips a claim with no file path, since the verifier has no file to read", () => {
		const dir = setup();
		write(
			dir,
			"o__r__5__anthropic",
			"anthropic",
			[claim("a", { path: null, source: "body", commentId: null })],
			[{ claimId: "a", label: "rejected", confirmed: true }],
		);
		const { items, skipped } = selectItems(dir);
		expect(items).toEqual([]);
		expect(skipped).toMatchObject({ noPath: 1 });
	});

	it("ignores fixtures without a labels file", () => {
		const dir = setup();
		write(
			dir,
			"o__r__5__anthropic",
			"anthropic",
			[claim("a")],
			[{ claimId: "a", label: "fixed", confirmed: true }],
		);
		writeFileSync(join(dir, "o__r__9__anthropic.json"), "{}");
		expect(selectItems(dir).items).toHaveLength(1);
	});
});
