import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../ledger/types.js";
import { diffRoundEvents } from "./gate-events.js";

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
	id: "f1",
	round: 1,
	path: "src/a.ts",
	line: 3,
	severity: "P1",
	title: "Retry loop swallows the error",
	status: "open",
	decidedBy: null,
	reason: null,
	evidence: ["head:h1"],
	...over,
});

describe("diffRoundEvents", () => {
	it("emits fixed for open to fixed with the inferred note", () => {
		const after = entry({
			status: "fixed",
			evidence: ["head:h2", "inferred: absent after diff changed"],
		});
		expect(diffRoundEvents([entry()], [after], "h2")).toEqual([
			{
				type: "event",
				findingId: "f1",
				status: "fixed",
				by: "gate-inferred",
				atHead: "h2",
				fixCommit: null,
				path: "src/a.ts",
				title: "Retry loop swallows the error",
				severity: "P1",
				note: "inferred: absent after diff changed",
			},
		]);
	});

	it("emits fixed for an entry missing before", () => {
		const after = entry({ status: "fixed", evidence: ["inferred: x"] });
		expect(diffRoundEvents([], [after], "h2")).toEqual([
			{
				type: "event",
				findingId: "f1",
				status: "fixed",
				by: "gate-inferred",
				atHead: "h2",
				fixCommit: null,
				path: "src/a.ts",
				title: "Retry loop swallows the error",
				severity: "P1",
				note: "inferred: x",
			},
		]);
	});

	it("emits fixed for acknowledged to fixed", () => {
		const events = diffRoundEvents(
			[entry({ status: "acknowledged" })],
			[entry({ status: "fixed", evidence: ["inferred: y"] })],
			"h2",
		);
		expect(events).toMatchObject([{ status: "fixed", findingId: "f1" }]);
	});

	it("emits reopened for fixed to open", () => {
		const events = diffRoundEvents(
			[entry({ status: "fixed" })],
			[entry()],
			"h3",
		);
		expect(events).toMatchObject([
			{
				status: "reopened",
				by: "gate-inferred",
				atHead: "h3",
				findingId: "f1",
			},
		]);
	});

	it("emits nothing for unchanged or still-open entries", () => {
		expect(diffRoundEvents([entry()], [entry()], "h")).toEqual([]);
		expect(
			diffRoundEvents(
				[entry({ status: "fixed" })],
				[entry({ status: "fixed" })],
				"h",
			),
		).toEqual([]);
	});
});
