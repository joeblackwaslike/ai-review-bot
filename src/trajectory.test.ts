import { describe, expect, it } from "vitest";
import type { Verdict } from "./feedback/types.js";
import type { LedgerEntry, LedgerStatus } from "./ledger/types.js";
import {
	classifyFinding,
	limitsForScore,
	scoreTrajectory,
} from "./trajectory.js";

const entry = (
	status: LedgerStatus,
	over: Partial<LedgerEntry> = {},
): LedgerEntry => ({
	id: `e${Math.random()}`,
	round: 0,
	path: "a.ts",
	line: 1,
	severity: "P2",
	title: "t",
	status,
	decidedBy: null,
	reason: null,
	evidence: [],
	...over,
});

const none = (): Verdict[] => [];

describe("classifyFinding", () => {
	it.each([
		"fixed",
		"resolved",
		"acknowledged",
	] as const)("%s by author is accepted, by reviewer unanswered", (s) => {
		expect(classifyFinding(entry(s, { decidedBy: "author" }), [])).toBe(
			"accepted",
		);
		expect(classifyFinding(entry(s, { decidedBy: "reviewer" }), [])).toBe(
			"unanswered",
		);
	});
	it("lets a settled status win over a contrary reaction", () => {
		expect(classifyFinding(entry("rejected"), ["up"])).toBe("rejected");
		expect(
			classifyFinding(entry("fixed", { decidedBy: "author" }), ["down"]),
		).toBe("accepted");
	});
	it("maps rejected and deferred statuses", () => {
		expect(classifyFinding(entry("rejected"), [])).toBe("rejected");
		expect(classifyFinding(entry("deferred"), [])).toBe("deferred");
	});
	it("uses reactions only for open entries", () => {
		expect(classifyFinding(entry("open"), [])).toBe("unanswered");
		expect(classifyFinding(entry("open"), ["down"])).toBe("rejected");
		expect(classifyFinding(entry("open"), ["up"])).toBe("accepted");
		expect(classifyFinding(entry("open"), ["confused"])).toBe("unanswered");
		expect(classifyFinding(entry("rejected"), ["up"])).toBe("rejected");
	});
});

describe("scoreTrajectory", () => {
	it("is null with no entries", () => {
		expect(scoreTrajectory([], none, 1).score).toBeNull();
	});
	it("scores one round", () => {
		const es = [
			entry("rejected"),
			entry("rejected"),
			entry("rejected"),
			entry("fixed", { decidedBy: "author" }),
		];
		const r = scoreTrajectory(es, none, 1);
		expect(r.score).toBeCloseTo(0.75, 4);
		expect(r.rounds[0]?.age).toBe(0);
	});
	it("weights newer rounds more", () => {
		const es = [
			...Array.from({ length: 4 }, () => entry("rejected", { round: 0 })),
			...Array.from({ length: 4 }, () =>
				entry("fixed", { round: 1, decidedBy: "author" }),
			),
		];
		expect(scoreTrajectory(es, none, 2).score).toBeCloseTo(0.3333, 4);
	});
	it("skips all-unanswered rounds and ignores future rounds", () => {
		const es = [
			entry("rejected", { round: 0 }),
			entry("open", { round: 1 }),
			entry("fixed", { round: 2, decidedBy: "author" }),
		];
		const r = scoreTrajectory(es, none, 2);
		expect(r.score).toBe(1);
		expect(r.rounds).toHaveLength(1);
	});
});

describe("scoreTrajectory details", () => {
	it("weights deferred findings at half a rejection", () => {
		const es = [
			entry("rejected"),
			entry("deferred"),
			entry("deferred"),
			entry("fixed", { decidedBy: "author" }),
		];
		expect(scoreTrajectory(es, none, 1).score).toBe(0.5);
	});
	it("passes reactions into classification", () => {
		const es = [entry("open")];
		expect(scoreTrajectory(es, () => ["down"], 1).score).toBe(1);
		expect(scoreTrajectory(es, () => [], 1).score).toBeNull();
	});
	it("ages non-contiguous rounds from the current round", () => {
		const es = [
			entry("rejected", { round: 0 }),
			entry("fixed", { round: 2, decidedBy: "author" }),
		];
		const r = scoreTrajectory(es, none, 4);
		expect(r.rounds.map((x) => x.age)).toEqual([3, 1]);
		expect(r.score).toBeCloseTo(0.125 / 0.625, 4);
	});
});

describe("limitsForScore", () => {
	it("bands on the unrounded score", () => {
		expect(limitsForScore(0.34996)).toEqual({ floor: null, budget: null });
	});
	it("maps bands", () => {
		const noLimits = { floor: null, budget: null };
		expect(limitsForScore(null)).toEqual(noLimits);
		expect(limitsForScore(0.34)).toEqual(noLimits);
		expect(limitsForScore(0.35)).toEqual({ floor: null, budget: 10 });
		expect(limitsForScore(0.59)).toEqual({ floor: null, budget: 10 });
		expect(limitsForScore(0.6)).toEqual({ floor: "P2", budget: 5 });
		expect(limitsForScore(1)).toEqual({ floor: "P2", budget: 5 });
	});
});
