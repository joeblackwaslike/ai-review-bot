import { describe, expect, it } from "vitest";
import { formatSpikeReport, scoreSpike } from "./score.js";
import type { SpikeItem, SpikeJudge, SpikeResult } from "./types.js";

const item = (id: string, over: Partial<SpikeItem> = {}): SpikeItem => ({
	id,
	fixtureId: "fx",
	producer: "anthropic",
	confirmed: true,
	label: "rejected",
	owner: "o",
	repo: "r",
	headSha: "sha",
	path: "a.ts",
	line: 1,
	severity: "P2",
	title: id,
	text: id,
	...over,
});

const judge: SpikeJudge = {
	id: "openai-cheap",
	tier: "cheap",
	vendor: "openai",
	model: "gpt-6-luna",
	effort: "none",
};

const result = (
	itemId: string,
	refuted: boolean,
	cost = 0.01,
): SpikeResult => ({
	itemId,
	judgeId: judge.id,
	outcome: refuted
		? {
				kind: "verdict",
				refuted: true,
				reason: "pure_style",
				rationale: "x",
				costUsd: cost,
			}
		: {
				kind: "verdict",
				refuted: false,
				reason: null,
				rationale: "x",
				costUsd: cost,
			},
});

const unverified = (itemId: string): SpikeResult => ({
	itemId,
	judgeId: judge.id,
	outcome: { kind: "unverified", why: "no file", costUsd: 0 },
});

describe("scoreSpike", () => {
	it("measures how many confirmed-rejected findings the verifier drops", () => {
		const items = [item("r1"), item("r2"), item("r3"), item("r4"), item("r5")];
		const results = [
			result("r1", true),
			result("r2", true),
			result("r3", false),
			result("r4", false),
			result("r5", false),
		];
		const [cell] = scoreSpike(items, [judge], results);
		expect(cell?.rejected).toEqual({ n: 5, dropped: 2 });
		expect(cell?.rejectedDropRate).toBeCloseTo(0.4);
	});

	it("counts a fixed P1 and a fixed P2 drop separately", () => {
		const items = [
			item("f1", { label: "fixed", severity: "P1" }),
			item("f2", { label: "fixed", severity: "P2" }),
			item("f3", { label: "fixed", severity: "P3" }),
			item("f4", { label: "fixed", severity: "P3" }),
		];
		const results = [
			result("f1", false),
			result("f2", true),
			result("f3", false),
			result("f4", false),
		];
		const [cell] = scoreSpike(items, [judge], results);
		expect(cell?.fixedP01).toEqual({ n: 1, dropped: 0 });
		expect(cell?.fixedP23).toEqual({ n: 3, dropped: 1 });
	});

	it("keeps provisional labels out of the headline counts", () => {
		const items = [
			item("r1", { confirmed: false }),
			item("r2", { confirmed: true }),
		];
		const results = [result("r1", true), result("r2", false)];
		const [cell] = scoreSpike(items, [judge], results);
		expect(cell?.rejected).toEqual({ n: 1, dropped: 0 });
		expect(cell?.provisionalRejected).toEqual({ n: 1, dropped: 1 });
	});

	it("counts unverified results apart and leaves them out of the drop rates", () => {
		const items = [item("r1"), item("r2")];
		const [cell] = scoreSpike(
			items,
			[judge],
			[result("r1", true), unverified("r2")],
		);
		expect(cell?.unverified).toBe(1);
		expect(cell?.rejected).toEqual({ n: 1, dropped: 1 });
	});

	it("scores only the pairs a judge actually saw", () => {
		const items = [item("a"), item("b", { producer: "openai" })];
		const [cell] = scoreSpike(
			items,
			[judge],
			[result("a", true), result("b", true)],
		);
		expect(cell?.producer).toBe("anthropic");
		expect(cell?.rejected.n).toBe(1);
	});

	it("passes only when it drops 40% of rejected, no fixed P1, and at most 5% of fixed P2 and P3", () => {
		const rejected = Array.from({ length: 10 }, (_, i) => item(`r${i}`));
		const fixed = Array.from({ length: 20 }, (_, i) =>
			item(`f${i}`, { label: "fixed", severity: "P3" }),
		);
		const make = (rejectedDrops: number, fixedDrops: number) => {
			const results = [
				...rejected.map((r, i) => result(r.id, i < rejectedDrops)),
				...fixed.map((f, i) => result(f.id, i < fixedDrops)),
			];
			return scoreSpike([...rejected, ...fixed], [judge], results)[0];
		};
		expect(make(4, 1)?.meetsCriteria).toBe(true);
		expect(make(3, 0)?.meetsCriteria).toBe(false);
		expect(make(5, 2)?.meetsCriteria).toBe(false);
	});

	it("fails the criteria on any dropped fixed P1", () => {
		const items = [
			...Array.from({ length: 5 }, (_, i) => item(`r${i}`)),
			item("f1", { label: "fixed", severity: "P1" }),
		];
		const results = [
			...items.slice(0, 5).map((r) => result(r.id, true)),
			result("f1", true),
		];
		expect(scoreSpike(items, [judge], results)[0]?.meetsCriteria).toBe(false);
	});

	it("adds up the cost of a cell", () => {
		const items = [item("a"), item("b")];
		const [cell] = scoreSpike(
			items,
			[judge],
			[result("a", true, 0.25), result("b", false, 0.5)],
		);
		expect(cell?.costUsd).toBeCloseTo(0.75);
	});
});

describe("formatSpikeReport", () => {
	it("renders one row per producer and judge with the criteria verdict", () => {
		const items = [item("r1"), item("f1", { label: "fixed", severity: "P3" })];
		const cells = scoreSpike(
			items,
			[judge],
			[result("r1", true), result("f1", false)],
		);
		const table = formatSpikeReport(cells);
		expect(table).toContain("| Producer | Judge | Tier |");
		expect(table).toContain("anthropic");
		expect(table).toContain("gpt-6-luna");
		expect(table).toMatch(/\| (yes|no) \|/);
	});
});
