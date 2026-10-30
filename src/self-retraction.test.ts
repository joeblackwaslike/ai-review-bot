import { describe, expect, it } from "vitest";
import { isSelfRetracted } from "./self-retraction.js";

const retracted = (title: string, body: string) =>
	isSelfRetracted({ title, body });

describe("isSelfRetracted positives, one per phrase family", () => {
	it("no actionable defect in the closing sentence", () => {
		expect(
			retracted(
				"Queue slot accounting",
				"The queue slot is held while waiting for the gap. This is intended. No actionable defect found.",
			),
		).toBe(true);
	});

	it("not flagging as a defect", () => {
		expect(
			retracted(
				"Fallback",
				"Covered by blockReason. Not flagging as a defect.",
			),
		).toBe(true);
	});

	it("retracted at the end", () => {
		expect(
			retracted(
				"pause() semantics",
				"It is never exercised mid-flight. No actionable defect; retracted.",
			),
		).toBe(true);
		expect(retracted("Race", "On reflection the guard holds. Retracted.")).toBe(
			true,
		);
	});

	it("looks consistent or resolved as the last sentence", () => {
		expect(
			retracted(
				"Stale env",
				"The Secret may not roll the pods. This looks resolved by the explicit `kubectl rollout restart` call.",
			),
		).toBe(true);
		expect(
			retracted(
				"Schema",
				"The fields match what Playwright emits, so this looks consistent.",
			),
		).toBe(true);
	});

	it("no new findings beyond prior reviews", () => {
		expect(retracted("No new findings beyond prior reviews", "")).toBe(true);
		expect(
			retracted(
				"Docs only",
				"Documentation-only change; no additional material issues beyond prior review",
			),
		).toBe(true);
	});

	it("already covered by prior reviewers", () => {
		expect(
			retracted(
				"All substantive issues are docs-only and already extensively covered by prior reviewers",
				"",
			),
		).toBe(true);
	});

	it("nothing to do this round", () => {
		expect(
			retracted("No code changes this round; only doc narrative revised", ""),
		).toBe(true);
		expect(retracted("Docs-only PR, no executable tests applicable", "")).toBe(
			true,
		);
	});

	it("ignores markdown emphasis around the phrase", () => {
		expect(
			retracted("Race", "The guard holds. **No actionable defect found.**"),
		).toBe(true);
	});
});

describe("isSelfRetracted keeps real findings", () => {
	it("keeps a title that starts with No but names a defect", () => {
		expect(
			retracted("No test coverage for the new parser", "Add a test."),
		).toBe(false);
		expect(retracted("No retry on 429", "A 429 aborts the whole run.")).toBe(
			false,
		);
	});

	it("keeps a finding with a contrast after the phrase", () => {
		expect(
			retracted(
				"Token loss on retry",
				"The loop reads fine. There is no functional bug on the happy path, but a retry loses the token.",
			),
		).toBe(false);
		expect(
			retracted(
				"Token loss on retry",
				"No actionable defect on the happy path. However, a retry loses the token.",
			),
		).toBe(false);
	});

	it("does not count a phrase that sits only inside code", () => {
		expect(
			retracted(
				"Misleading log",
				"The log line prints `no actionable defect found` even when the scan failed.",
			),
		).toBe(false);
		expect(
			retracted(
				"Misleading log",
				"Fix the message.\n```ts\nlog('No actionable defect found; retracted.')\n```",
			),
		).toBe(false);
	});

	it("keeps a retraction phrase that is followed by a longer real tail", () => {
		expect(
			retracted(
				"Leak",
				"This is not a bug in the parser. The socket opened in start() is never closed on the error path. Wrap it in try/finally.",
			),
		).toBe(false);
	});

	it("keeps a nit that says it is not a bug", () => {
		expect(
			retracted(
				"Low",
				"The helper comment says chunks, but the real concern is line endings. This is not a bug, only a stale comment worth rewording.",
			),
		).toBe(false);
		expect(
			retracted(
				"Low",
				"The cast after the guard is safe but a little awkward. A low-risk nit, not a defect.",
			),
		).toBe(false);
	});

	it("keeps a docs gap that says there is no functional issue", () => {
		expect(
			retracted(
				"Nit: test title is stale",
				"The behaviour is correct, but the description still names the old value. Minor readability point, no functional issue.",
			),
		).toBe(false);
		expect(
			retracted(
				"Low",
				"The loop is correct but brittle and a reader may misjudge it. No actual bug given tests pass.",
			),
		).toBe(false);
	});

	it("keeps a real finding that mentions no new P0 findings mid-text", () => {
		expect(
			retracted(
				"Count surviving P0s in readiness",
				"Prior P0s are ignored when scoring. Add a regression test for a prior P0 alongside no new P0 findings.",
			),
		).toBe(false);
	});

	it("keeps a retraction-looking phrase that is followed by a request", () => {
		expect(
			retracted(
				"Low",
				"The default is shown as none. No bug here; just confirm the prompt still reads well.",
			),
		).toBe(false);
	});

	it("keeps a no-actionable phrase that names an exception", () => {
		for (const tail of [
			"No actionable issue beyond the lost notes mentioned elsewhere.",
			"No actionable defect found other than the missing timeout.",
			"No actionable bug apart from the stale cache entry.",
			"No actionable problem aside from the retry path.",
			"No actionable finding except the unclosed handle.",
		])
			expect(
				retracted("Low", `The update is atomic, so this is fine. ${tail}`),
			).toBe(false);
	});

	it("still retracts no new findings beyond prior reviews", () => {
		expect(retracted("No new findings beyond prior reviews", "")).toBe(true);
	});

	it("still catches literal retraction wording", () => {
		expect(
			retracted(
				"Low",
				"The guard holds. No issue here, withdrawing this observation.",
			),
		).toBe(true);
		expect(
			retracted(
				"Low",
				"On a second look the loop is right. No actionable defect found.",
			),
		).toBe(true);
	});

	it("handles empty input", () => {
		expect(retracted("", "")).toBe(false);
	});
});
