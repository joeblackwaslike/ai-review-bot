import { describe, expect, it } from "vitest";
import {
	carrierBody,
	type PostedComment,
	type Provenance,
	pairWithProvenance,
	parsePostedAt,
} from "./capture.js";

function comment(over: Partial<PostedComment> & { id: number }): PostedComment {
	return {
		path: "src/x.ts",
		line: 10,
		pull_request_review_id: 900,
		...over,
	};
}

const provenance: Provenance = new Map([
	[
		"src/x.ts:10",
		{ skills: ["code-reviewer.md"], title: "a finding", severity: "medium" },
	],
]);

describe("pairWithProvenance", () => {
	it("pairs a posted comment with the provenance for its location", () => {
		const paired = pairWithProvenance([comment({ id: 1 })], 900, provenance);
		expect(paired).toHaveLength(1);
		expect(paired[0]).toMatchObject({
			skills: ["code-reviewer.md"],
			title: "a finding",
			severity: "medium",
		});
	});

	it("ignores comments belonging to a different review", () => {
		expect(
			pairWithProvenance(
				[comment({ id: 1, pull_request_review_id: 111 })],
				900,
				provenance,
			),
		).toEqual([]);
	});

	// The catalog is a join target; a row naming nothing cannot be matched to
	// feedback later, so it is better absent than present-and-empty.
	it("skips a comment with no provenance rather than cataloguing an empty title", () => {
		expect(
			pairWithProvenance(
				[comment({ id: 1, path: "src/other.ts", line: 3 })],
				900,
				provenance,
			),
		).toEqual([]);
	});

	it("keeps every comment that matches, not just the first", () => {
		const multi: Provenance = new Map([
			["src/x.ts:10", { skills: ["a.md"], title: "t1", severity: "low" }],
			["src/x.ts:20", { skills: ["b.md"], title: "t2", severity: "high" }],
		]);
		const paired = pairWithProvenance(
			[comment({ id: 1 }), comment({ id: 2, line: 20 })],
			900,
			multi,
		);
		expect(paired.map((p) => p.title)).toEqual(["t1", "t2"]);
	});
});

describe("carrierBody", () => {
	it("carries the summary and teaches all three reactions", () => {
		const body = carrierBody("ai-review", "Looks broadly fine.");
		expect(body).toContain("Looks broadly fine.");
		for (const reaction of ["👍", "👎", "😕"]) {
			expect(body).toContain(reaction);
		}
	});

	it("asks for a reason alongside the ambiguous reaction", () => {
		expect(carrierBody("ai-review", "s")).toContain("a reply saying why");
	});

	it("degrades to a placeholder rather than rendering an empty section", () => {
		expect(carrierBody("ai-review", "   ")).toContain("_(no summary)_");
	});
});

describe("parsePostedAt", () => {
	it("uses GitHub's timestamp when present", () => {
		expect(parsePostedAt("2026-07-30T12:00:00Z")).toEqual(
			new Date("2026-07-30T12:00:00Z"),
		);
	});

	// A retry or a delayed capture must not shift when a finding appears to have
	// been raised — the corpus is time-series data and the ordering matters.
	it("falls back to now when the timestamp is absent", () => {
		expect(parsePostedAt(undefined).getTime()).toBeGreaterThan(0);
	});

	it("falls back rather than writing an Invalid Date into a NOT NULL column", () => {
		expect(Number.isNaN(parsePostedAt("not-a-date").getTime())).toBe(false);
	});
});
