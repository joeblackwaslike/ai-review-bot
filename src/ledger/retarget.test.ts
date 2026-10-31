import { describe, expect, it } from "vitest";
import { findingId, type PersistedFinding } from "../review-state.js";
import { retargetCarried } from "./retarget.js";

function finding(path: string | null, line: number | null, title: string) {
	return {
		id: findingId(path, line, title),
		path,
		line,
		title,
		severity: "P2",
		status: "open",
	} as PersistedFinding;
}

describe("retargetCarried", () => {
	it("keeps a finding whose path is in the PR unchanged", () => {
		const f = finding("src/a.ts", 3, "Bug");
		const r = retargetCarried([f], [{ filename: "src/a.ts" }]);
		expect(r.kept).toEqual([f]);
		expect(r.retired).toEqual([]);
	});

	it("maps a finding through previous_filename and recomputes its id with findingId(newPath, line, title)", () => {
		const f = finding("src/old.ts", 7, "Bug");
		const r = retargetCarried(
			[f],
			[{ filename: "src/new.ts", previous_filename: "src/old.ts" }],
		);
		expect(r.kept).toEqual([
			{ ...f, path: "src/new.ts", id: findingId("src/new.ts", 7, "Bug") },
		]);
		expect(r.retired).toEqual([]);
	});

	it("retires a finding whose path is neither a filename nor a previous_filename", () => {
		const f = finding("src/self-check.ts", 1, "Stale");
		const r = retargetCarried([f], [{ filename: "src/replay/check-rule.ts" }]);
		expect(r.kept).toEqual([]);
		expect(r.retired).toEqual([f]);
	});

	it("leaves a path-less finding in kept", () => {
		const f = finding(null, null, "General");
		const r = retargetCarried([f], []);
		expect(r.kept).toEqual([f]);
	});

	it("returns kept and retired in the input order", () => {
		const a = finding("src/a.ts", 1, "A");
		const b = finding("gone.ts", 1, "B");
		const c = finding("src/old.ts", 2, "C");
		const d = finding("gone2.ts", 1, "D");
		const e = finding(null, null, "E");
		const r = retargetCarried(
			[a, b, c, d, e],
			[
				{ filename: "src/a.ts" },
				{ filename: "src/new.ts", previous_filename: "src/old.ts" },
			],
		);
		expect(r.kept.map((x) => x.title)).toEqual(["A", "C", "E"]);
		expect(r.retired.map((x) => x.title)).toEqual(["B", "D"]);
	});

	it("filename wins over previous_filename when a new file takes a renamed file's old path", () => {
		const f = finding("src/a.ts", 4, "Bug");
		const r = retargetCarried(
			[f],
			[
				{ filename: "src/b.ts", previous_filename: "src/a.ts" },
				{ filename: "src/a.ts" },
			],
		);
		expect(r.kept).toEqual([f]);
		expect(r.retired).toEqual([]);
	});

	it("empty files list retires every pathed finding", () => {
		const pathed = finding("src/a.ts", 1, "A");
		const general = finding(null, null, "G");
		const r = retargetCarried([pathed, general], []);
		expect(r.kept).toEqual([general]);
		expect(r.retired).toEqual([pathed]);
	});
});
