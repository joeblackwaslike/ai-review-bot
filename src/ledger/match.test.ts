import { describe, expect, it } from "vitest";
import { findSettledMatch } from "./match.js";
import type { LedgerEntry } from "./types.js";

function entry(over: Partial<LedgerEntry>): LedgerEntry {
	return {
		id: "e1",
		round: 1,
		path: "src/a.ts",
		line: 10,
		severity: "P1",
		title: "placeholder title words",
		status: "rejected",
		decidedBy: "author",
		reason: null,
		evidence: [],
		...over,
	};
}

describe("findSettledMatch", () => {
	it("matches a reworded repeat 12 lines away (tier 1)", () => {
		const e = entry({
			title: "`listFindings` drops the body column in the SQL query",
		});
		const f = {
			path: "src/a.ts",
			line: 22,
			title: "SQL query in `listFindings` omits the body column",
		};
		expect(findSettledMatch(f, [e])).toBe(e);
	});

	it("matches the same claim reworded 400 lines away with a shared identifier (tier 2)", () => {
		const e = entry({
			title: "`listFindings` drops the body column in the SQL query",
		});
		const f = {
			path: "src/a.ts",
			line: 410,
			title: "`listFindings` drops the body column from the SQL query",
		};
		expect(findSettledMatch(f, [e])).toBe(e);
	});

	it("matches a verbatim re-raise 400 lines later in the same file (tier 2)", () => {
		const title = "`listFindings` drops the body column in the SQL query";
		const e = entry({ title });
		const f = { path: "src/a.ts", line: 410, title };
		expect(findSettledMatch(f, [e])).toBe(e);
	});

	it("does not match a reworded repeat more than 30 lines away (accepted cost)", () => {
		const e = entry({
			title: "`listFindings` drops the body column in the SQL query",
		});
		const f = {
			path: "src/a.ts",
			line: 50,
			title: "SQL query in `listFindings` omits the body column",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("does not match credentials vs connections 490 lines apart", () => {
		const e = entry({
			line: 10,
			title: "`loadUser` leaks credentials after timeout",
		});
		const f = {
			path: "src/a.ts",
			line: 500,
			title: "`loadUser` leaks connections after timeout",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("does not match two different defects in one function 490 lines apart", () => {
		const e = entry({
			line: 10,
			title: "`loadUser` leaks credentials after timeout",
		});
		const f = {
			path: "src/a.ts",
			line: 500,
			title: "`loadUser` swallows connection errors during retry",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("does not match an identical generic title in two files with no shared identifier", () => {
		const e = entry({ path: "src/a.ts", title: "Missing error handling" });
		const f = { path: "src/b.ts", line: 10, title: "Missing error handling" };
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("matches an identical title in two files sharing an identifier (moved file)", () => {
		const e = entry({
			path: "src/a.ts",
			title: "`fetchUser` lacks error handling",
		});
		const f = {
			path: "src/b.ts",
			line: 3,
			title: "`fetchUser` lacks error handling",
		};
		expect(findSettledMatch(f, [e])).toBe(e);
	});

	it("never matches an open entry", () => {
		const e = entry({
			status: "open",
			title: "`listFindings` drops the body column in the SQL query",
		});
		const f = {
			path: "src/a.ts",
			line: 10,
			title: "`listFindings` drops the body column in the SQL query",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("matches a reworded general finding and not an unrelated one", () => {
		const e = entry({
			path: null,
			line: null,
			title: "Tests do not cover the retry backoff behaviour",
		});
		const same = {
			path: null,
			title: "Retry backoff behaviour is not covered by tests",
		};
		const other = {
			path: null,
			title: "Documentation omits environment variable defaults",
		};
		expect(findSettledMatch(same, [e])).toBe(e);
		expect(findSettledMatch(other, [e])).toBeNull();
	});
});
