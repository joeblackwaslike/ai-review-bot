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

	it("matches a reworded inline repeat by its body when the titles diverge", () => {
		const e = entry({
			line: 96,
			title: "Do not silently discard browser-context cleanup failures",
			body: "When context.close() rejects after the page work finishes, the error is caught and dropped, so a leaked browser context is never reported and later requests run against a stale context.",
		});
		const f = {
			path: "src/a.ts",
			line: 111,
			title: "Context cleanup failures are swallowed after a successful fetch",
			body: "If closing the browser context rejects, the catch drops the error; the leaked context is never reported and later requests reuse a stale context.",
		};
		expect(findSettledMatch(f, [e])).toBe(e);
	});

	it("does not body-match two different defects in one function", () => {
		const e = entry({
			line: 96,
			title: "Do not silently discard browser-context cleanup failures",
			body: "When context.close() rejects after the page work finishes, the error is caught and dropped, so a leaked browser context is never reported.",
		});
		const f = {
			path: "src/a.ts",
			line: 104,
			title:
				"Do not release the scheduler while a timed-out navigation is still running",
			body: "The timeout handler resolves the task and frees its scheduler slot while page.goto is still in flight, so the next queued task overlaps the old navigation.",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("does not body-match findings without bodies on title words alone", () => {
		const e = entry({
			line: 96,
			title: "Context cleanup errors dropped silently",
		});
		const f = {
			path: "src/a.ts",
			line: 100,
			title: "Context cleanup ordering differs from setup ordering",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("matches a general finding restating a settled inline entry by title, ignoring path", () => {
		const e = entry({
			title: "Capture file pruning can delete files out of chronological order",
		});
		const f = {
			path: null,
			title: "Capture file pruning can delete files out of chronological order",
		};
		expect(findSettledMatch(f, [e])).toBe(e);
	});

	it("matches an inline finding restating a settled general entry by title", () => {
		const e = entry({
			path: null,
			line: null,
			title:
				"Shell injection risk from unsanitized URL interpolation in curl recipe",
		});
		const f = {
			path: "docs/recipe.md",
			line: 12,
			title:
				"Shell injection risk via unsanitized URL interpolation in the curl recipe",
		};
		expect(findSettledMatch(f, [e])).toBe(e);
	});

	it("does not cross-surface match two different test gaps with similar titles", () => {
		const e = entry({
			title: "Tests do not cover the retry backoff behaviour",
		});
		const f = {
			path: null,
			title: "Tests do not cover the retry jitter calculation",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("matches a general finding naming a code identifier from a settled inline entry's body", () => {
		const e = entry({
			path: "src/throttle.ts",
			line: 59,
			title:
				"Off-by-one in queue-full check lets 6 tasks wait instead of the documented 5",
			body: "`run()` compares `this.inFlight > this.maxQueue` before incrementing, so the scheduler allows six tasks to wait before QueueFullError is thrown while the comment documents five waiting tasks.",
		});
		const f = {
			path: null,
			title:
				"Scheduler.inFlight off-by-one still allows 6 waiting tasks instead of the documented 5",
		};
		expect(findSettledMatch(f, [e])).toBe(e);
	});

	it("does not cross-surface match a different defect that names the same identifier", () => {
		const e = entry({
			path: "src/throttle.ts",
			line: 59,
			title:
				"Off-by-one in queue-full check lets 6 tasks wait instead of the documented 5",
			body: "`run()` compares `this.inFlight > this.maxQueue` before incrementing, so six tasks can wait before QueueFullError is thrown.",
		});
		const f = {
			path: null,
			title:
				"pause() does not stop inFlight work already holding a profile slot",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("does not cross-surface match high word overlap with no shared identifier", () => {
		const e = entry({
			path: "src/gateway.ts",
			line: 40,
			title: "Stale console.warn comment still describes the old token flow",
			body: "The comment above the warning says the gateway returns 423 or 429 when the token is missing, but the code now returns 401; tests cover neither status.",
		});
		const f = {
			path: null,
			title: "No test covers gateway 423/429 status when the token is missing",
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
