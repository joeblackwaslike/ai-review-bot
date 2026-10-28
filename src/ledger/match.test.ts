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

	it("does not let a product name like eBay lower the title bar", () => {
		const e = entry({
			path: "src/detect.ts",
			line: 13,
			title:
				"classifyPage: EBAY_ERROR_TITLE regex matches any page whose title starts with 'Error Page', even for non-eBay profiles/hosts",
		});
		const f = {
			path: "src/detect.ts",
			line: 14,
			title:
				"eBay error-page title regex is broad and only anchored at the start",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("never matches a missing-test finding to the defect it would test", () => {
		const e = entry({
			path: "src/throttle.ts",
			line: 76,
			title: "Scheduler.inFlight off-by-one allows 6 waiting tasks, not 5",
			body: "`inFlight` is incremented for every call to `run`. The guard `if (this.inFlight > this.maxQueue)` rejects only once `inFlight` exceeds `maxQueue`, giving 6 waiting tasks, not 5 as documented. This was already flagged in a prior review round and remains unaddressed.",
		});
		const f = {
			path: null,
			title:
				"No test for the Scheduler.inFlight off-by-one carried over from prior review rounds",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("counts a shared identifier as one word, so a fix's opposite defect does not match", () => {
		const restart = {
			path: "deployment/scripts/deploy-app.sh",
			line: 151,
			title:
				"`kubectl rollout restart deployment/ai-listings` is now called unconditionally",
			body: "The restart runs after every `kubectl apply`, forcing a pod restart on every no-op deploy, where rollout used to happen only via spec changes. Gate it on an actual change, e.g. only restart when the STEALTH_BROWSER_TOKEN value changed.",
		};
		const opposite = entry({
			path: null,
			line: null,
			title: "Rotated STEALTH_BROWSER_TOKEN requires manual pod rollout",
		});
		const same = entry({
			path: null,
			line: null,
			title:
				"Rotated STEALTH_BROWSER_TOKEN requires rollout-restart every deploy, including no-op deploys",
		});
		expect(findSettledMatch(restart, [opposite])).toBeNull();
		expect(findSettledMatch(restart, [same])).toBe(same);
	});

	it("does not body-match a sibling defect in the same snippet, and attributes to the most similar entry", () => {
		const healthCheck = entry({
			id: "health",
			line: 15,
			title:
				"Unset-credential check doesn't actually gate the health check/content request",
			body: 'The doc shows the env-var presence check and the curl health check as two separate commands (`[ -n "$STEALTH_BROWSER_URL" ] && ... || echo "not configured"` followed by an unconditional `curl ...`). If the variables are unset, the second line still executes, sending a curl request with an empty URL/Authorization header. The two commands should be combined so the health check only runs when credentials are present.',
		});
		const fetch = entry({
			id: "fetch",
			line: 17,
			title: "Credential check doesn't gate the subsequent fetch example",
			body: 'The new unset-credential guard (`[ -n "$STEALTH_BROWSER_URL" ] ... || echo "not configured"`) is a standalone diagnostic snippet. It doesn\'t control whether the `curl ... /content` command below it runs; an agent could still execute the fetch command even when credentials are unset. The doc should make clear the agent must skip the whole step before attempting the fetch.',
		});
		const f = {
			path: "src/a.ts",
			line: 31,
			title: "Credential check result not actually used to gate the fetch",
			body: "The health-check snippet prints `200` or `not configured` but the doc doesn't show the result controlling whether the subsequent 'Fetching a page' curl call runs. An agent could run the health check, see non-200 output, and still proceed to the fetch snippet. This mirrors the previously-flagged 'credential-unset check doesn't gate subsequent curl calls' issue.",
		};
		expect(findSettledMatch(f, [healthCheck])).toBeNull();
		expect(findSettledMatch(f, [healthCheck, fetch])).toBe(fetch);
		expect(findSettledMatch(f, [fetch, healthCheck])).toBe(fetch);
	});

	it("does not treat product names like GitHub or TypeScript as a shared code identifier", () => {
		const e = entry({
			path: ".github/workflows/ci.yml",
			line: 12,
			title: "Node version is not pinned in CI",
			body: "The GitHub Actions workflow installs the latest TypeScript compiler and Node on every run, so the compiler version can change between runs. Pin the TypeScript version in the workflow.",
		});
		const f = {
			path: null,
			title:
				"GitHub Actions workflow does not pin the TypeScript compiler version",
		};
		expect(findSettledMatch(f, [e])).toBeNull();
	});

	it("breaks an exact score tie by latest round, then lowest id, whatever the ledger order", () => {
		const title = "`listFindings` drops the body column in the SQL query";
		const older = entry({ id: "b", round: 1, title });
		const newer = entry({ id: "c", round: 2, title });
		const sameRound = entry({ id: "a", round: 2, title });
		const f = { path: "src/a.ts", line: 10, title };
		expect(findSettledMatch(f, [older, newer])).toBe(newer);
		expect(findSettledMatch(f, [newer, older])).toBe(newer);
		expect(findSettledMatch(f, [newer, sameRound])).toBe(sameRound);
		expect(findSettledMatch(f, [sameRound, newer])).toBe(sameRound);
	});
});
