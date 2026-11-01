import { describe, expect, it } from "vitest";
import { findProvenance } from "./comment-key.js";

describe("findProvenance", () => {
	it("returns the direct match when the parsed title matches exactly", () => {
		const provenance = new Map([
			["a.ts:5:short", { title: "short" }],
			["a.ts:5:short title", { title: "short title" }],
		]);
		const result = findProvenance(
			provenance,
			{ path: "a.ts", line: 5, body: "irrelevant" },
			"short",
		);
		expect(result?.title).toBe("short");
	});

	it("picks the longest bolded title when two entries both match the fallback scan", () => {
		const provenance = new Map([
			["a.ts:5:missing handling", { title: "missing handling" }],
			[
				"a.ts:5:missing error handling in catch block",
				{ title: "missing error handling in catch block" },
			],
		]);
		const result = findProvenance(
			provenance,
			{
				path: "a.ts",
				line: 5,
				body: "**missing error handling in catch block**",
			},
			"does not match either stored key",
		);
		expect(result?.title).toBe("missing error handling in catch block");
	});

	it("returns undefined when nothing at the same path/line matches", () => {
		const provenance = new Map([["a.ts:5:short", { title: "short" }]]);
		const result = findProvenance(
			provenance,
			{ path: "a.ts", line: 5, body: "no bolded title here" },
			"unmatched",
		);
		expect(result).toBeUndefined();
	});
});
