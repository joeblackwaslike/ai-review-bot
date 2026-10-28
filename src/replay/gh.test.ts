import { describe, expect, it } from "vitest";
import { mergePages } from "./gh.js";

describe("mergePages", () => {
	it("flattens array pages", () => {
		expect(mergePages([[1], [2, 3]])).toEqual([1, 2, 3]);
	});

	it("concatenates commits and files across object pages and keeps other fields from page one", () => {
		const merged = mergePages([
			{ merge_base_commit: { sha: "mb" }, commits: [{ sha: "a" }], files: [1] },
			{ merge_base_commit: { sha: "mb" }, commits: [{ sha: "b" }], files: [2] },
		]);
		expect(merged).toEqual({
			merge_base_commit: { sha: "mb" },
			commits: [{ sha: "a" }, { sha: "b" }],
			files: [1, 2],
		});
	});
});
