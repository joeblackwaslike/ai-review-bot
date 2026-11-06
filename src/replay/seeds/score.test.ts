import { describe, expect, it } from "vitest";
import type { Seed } from "./schema.js";
import { scoreSeed, seedGate } from "./score.js";

function seed(variant: string, truth: Seed["truth"], opId = "REL-01"): Seed {
	return { id: `${opId}/${variant}`, opId, variant, dir: "/x", truth };
}

const defectSeed = (variant = "original", opId = "REL-01") =>
	seed(
		variant,
		{
			clean: false,
			defects: [
				{ path: "src/a.ts", startLine: 10, endLine: 12, description: "d" },
			],
		},
		opId,
	);
const cleanSeed = (opId = "REL-01") => seed("clean", { clean: true }, opId);

const f = (path: string | null, line: number | null) => ({
	path,
	line,
	title: "t",
});

describe("scoreSeed", () => {
	it("found on a hit with no extras", () => {
		expect(scoreSeed(defectSeed(), [f("src/a.ts", 11)])).toEqual({
			outcome: "found",
			foundDefect: true,
			extraFindings: 0,
		});
	});

	it("range ends are inclusive", () => {
		for (const line of [10, 12]) {
			expect(scoreSeed(defectSeed(), [f("src/a.ts", line)]).foundDefect).toBe(
				true,
			);
		}
		for (const line of [9, 13]) {
			expect(scoreSeed(defectSeed(), [f("src/a.ts", line)]).foundDefect).toBe(
				false,
			);
		}
	});

	it("found with extra findings counts the extras", () => {
		expect(
			scoreSeed(defectSeed(), [
				f("src/a.ts", 10),
				f("src/b.ts", 1),
				f("src/a.ts", 50),
			]),
		).toEqual({ outcome: "found", foundDefect: true, extraFindings: 2 });
	});

	it("missed with no findings", () => {
		expect(scoreSeed(defectSeed(), [])).toEqual({
			outcome: "missed",
			foundDefect: false,
			extraFindings: 0,
		});
	});

	it("false-positive when only other findings exist", () => {
		expect(scoreSeed(defectSeed(), [f("src/b.ts", 11)])).toEqual({
			outcome: "false-positive",
			foundDefect: false,
			extraFindings: 1,
		});
	});

	it("a null path or line never counts as the defect", () => {
		expect(scoreSeed(defectSeed(), [f(null, 11)]).foundDefect).toBe(false);
		expect(scoreSeed(defectSeed(), [f("src/a.ts", null)]).foundDefect).toBe(
			false,
		);
		expect(scoreSeed(defectSeed(), [f(null, null)]).outcome).toBe(
			"false-positive",
		);
	});

	it("clean control: none is clean-ok, any finding is a false positive", () => {
		expect(scoreSeed(cleanSeed(), [])).toEqual({
			outcome: "clean-ok",
			foundDefect: false,
			extraFindings: 0,
		});
		expect(scoreSeed(cleanSeed(), [f("src/a.ts", 1)])).toEqual({
			outcome: "false-positive",
			foundDefect: false,
			extraFindings: 1,
		});
	});
});

describe("seedGate", () => {
	const ops = ["REL-01", "REL-10", "DEL-04", "REL-03", "MEC-01"];
	const missed = { outcome: "missed", foundDefect: false, extraFindings: 0 };
	const found = { outcome: "found", foundDefect: true, extraFindings: 0 };
	const cleanOk = { outcome: "clean-ok", foundDefect: false, extraFindings: 0 };

	function results(missedOps: string[]) {
		return [
			...ops.map((op) => ({
				seed: defectSeed("original", op),
				outcome: missedOps.includes(op) ? missed : found,
			})),
			...ops.map((op) => ({ seed: cleanSeed(op), outcome: cleanOk })),
		] as Parameters<typeof seedGate>[0];
	}

	it("passes with zero or exactly one missed original", () => {
		expect(seedGate(results([]))).toMatchObject({
			pass: true,
			originalsMissed: 0,
			cleanFindings: 0,
			reasons: [],
		});
		expect(seedGate(results(["DEL-04"]))).toMatchObject({
			pass: true,
			originalsMissed: 1,
		});
	});

	it("fails with two missed originals", () => {
		const g = seedGate(results(["DEL-04", "MEC-01"]));
		expect(g.pass).toBe(false);
		expect(g.originalsMissed).toBe(2);
		expect(g.reasons).toHaveLength(1);
	});

	it("fails on any finding on a clean control", () => {
		const r = results([]);
		r[r.length - 1] = {
			seed: cleanSeed("MEC-01"),
			outcome: {
				outcome: "false-positive",
				foundDefect: false,
				extraFindings: 3,
			},
		};
		const g = seedGate(r);
		expect(g.pass).toBe(false);
		expect(g.cleanFindings).toBe(3);
	});

	it("ignores variants when counting missed originals", () => {
		const r = [
			...results([]),
			{ seed: defectSeed("v1", "REL-01"), outcome: missed },
			{ seed: defectSeed("v2", "REL-01"), outcome: missed },
		] as Parameters<typeof seedGate>[0];
		expect(seedGate(r)).toMatchObject({ pass: true, originalsMissed: 0 });
	});
});
