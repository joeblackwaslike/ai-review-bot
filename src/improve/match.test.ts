import { describe, expect, it } from "vitest";
import { type CatalogEntry, fpSignature, matchToFinding } from "./match.js";

const catalog: CatalogEntry[] = [
	{ id: 10, commentId: 100, path: "src/a.ts", line: 5 },
	{ id: 11, commentId: 101, path: "src/b.ts", line: 7 },
	{ id: 12, commentId: 102, path: "src/b.ts", line: 7 },
];

describe("matchToFinding", () => {
	it("matches a reply to the finding at its thread root", () => {
		expect(
			matchToFinding(
				{ id: 1, commentId: 500, inReplyToId: 100, path: null, line: null },
				catalog,
			),
		).toEqual({ findingId: 10, method: "thread" });
	});

	it("matches a reaction by its own comment id", () => {
		expect(
			matchToFinding(
				{ id: 1, commentId: 101, inReplyToId: null, path: null, line: null },
				catalog,
			),
		).toEqual({ findingId: 11, method: "thread" });
	});

	it("falls back to a unique path:line", () => {
		expect(
			matchToFinding(
				{ id: 1, commentId: 900, inReplyToId: null, path: "src/a.ts", line: 5 },
				catalog,
			),
		).toEqual({ findingId: 10, method: "location" });
	});

	it("refuses an ambiguous location rather than picking one", () => {
		expect(
			matchToFinding(
				{ id: 1, commentId: 900, inReplyToId: null, path: "src/b.ts", line: 7 },
				catalog,
			),
		).toEqual({ findingId: null, method: "none" });
	});

	it("prefers thread linkage over a conflicting location", () => {
		expect(
			matchToFinding(
				{ id: 1, commentId: 900, inReplyToId: 100, path: "src/a.ts", line: 5 },
				catalog,
			).method,
		).toBe("thread");
	});

	it("uses the classifier hint only as a last resort", () => {
		expect(
			matchToFinding(
				{ id: 1, commentId: 900, inReplyToId: null, path: null, line: null },
				catalog,
				11,
			),
		).toEqual({ findingId: 11, method: "hint" });
	});

	it("falls back to the hint when the location is ambiguous", () => {
		expect(
			matchToFinding(
				{ id: 1, commentId: 900, inReplyToId: null, path: "src/b.ts", line: 7 },
				catalog,
				12,
			),
		).toEqual({ findingId: 12, method: "hint" });
	});

	it("ignores a hint naming a finding that does not exist", () => {
		expect(
			matchToFinding(
				{ id: 1, commentId: 900, inReplyToId: null, path: null, line: null },
				catalog,
				4242,
			),
		).toEqual({ findingId: null, method: "none" });
	});
});

describe("fpSignature", () => {
	it("groups the same claim across different symbols and line numbers", () => {
		expect(
			fpSignature(
				["code-reviewer.md"],
				"`closeSync` called on undefined at 312",
			),
		).toBe(
			fpSignature(["code-reviewer.md"], "`openSync` called on undefined at 47"),
		);
	});

	it("separates genuinely different claims", () => {
		expect(fpSignature([], "spawn error event is not handled")).not.toBe(
			fpSignature([], "directory fsync may fail silently"),
		);
	});

	it("is order-insensitive across skills and words", () => {
		expect(fpSignature(["b.md", "a.md"], "alpha beta")).toBe(
			fpSignature(["a.md", "b.md"], "beta alpha"),
		);
	});

	it("separates identical titles raised by different skills", () => {
		expect(fpSignature(["a.md"], "same title")).not.toBe(
			fpSignature(["b.md"], "same title"),
		);
	});
});
