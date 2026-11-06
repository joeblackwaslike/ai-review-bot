import { describe, expect, it } from "vitest";
import { isDirectional, splitCounts, splitOf } from "./splits.js";

const ids = (n: number) =>
	Array.from({ length: n }, (_, i) => `own/repo${i % 7}#${i}`);

describe("splitOf", () => {
	it("is deterministic and order independent", () => {
		const all = ids(50);
		const forward = all.map((id) => splitOf(id, "s"));
		const backward = [...all].reverse().map((id) => splitOf(id, "s"));
		expect(forward).toEqual(backward.reverse());
	});

	it("changes with the seed", () => {
		const a = ids(60).map((id) => splitOf(id, "one"));
		const b = ids(60).map((id) => splitOf(id, "two"));
		expect(a).not.toEqual(b);
	});

	it("is roughly balanced over 300 ids", () => {
		const counts = { tuning: 0, validation: 0, test: 0 };
		for (const id of ids(300)) counts[splitOf(id, "seed")]++;
		for (const n of Object.values(counts)) {
			expect(n).toBeGreaterThan(70);
			expect(n).toBeLessThan(130);
		}
	});
});

const fx = (split: "tuning" | "validation" | "test", repo: number, n: number) =>
	Array.from({ length: n }, (_, i) => ({
		id: `o/r${repo}#${split}${i}`,
		split,
		provider: "anthropic" as const,
	}));

describe("provider-suffixed ids", () => {
	it("puts both providers of one PR in the same split", () => {
		for (const id of ids(40)) {
			expect(splitOf(`${id}@openai`, "s")).toBe(
				splitOf(`${id}@anthropic`, "s"),
			);
			expect(splitOf(`${id}@openai`, "s")).toBe(splitOf(id, "s"));
		}
	});

	it("counts a PR recorded for both providers once", () => {
		const both = [
			{ id: "o/r#1@anthropic", split: "tuning" as const },
			{ id: "o/r#1@openai", split: "tuning" as const },
		];
		expect(splitCounts({ fixtures: both }).tuning).toBe(1);
	});
});

describe("splitCounts and isDirectional", () => {
	it("counts per split and repositories", () => {
		const counts = splitCounts({
			fixtures: [...fx("tuning", 1, 2), ...fx("test", 2, 1)],
		});
		expect(counts).toEqual({ tuning: 2, validation: 0, test: 1, repos: 2 });
	});

	it("is not directional at exactly 30 PRs, 10 per split, 5 repos", () => {
		const fixtures = [
			...fx("tuning", 1, 10),
			...fx("validation", 2, 10),
			...fx("test", 3, 8),
			...fx("test", 4, 1),
			...fx("test", 5, 1),
		];
		expect(isDirectional({ fixtures })).toBe(false);
	});

	it("is directional below 30 PRs, below 10 in a split, or below 5 repos", () => {
		const base = [
			...fx("tuning", 1, 10),
			...fx("validation", 2, 10),
			...fx("test", 3, 8),
			...fx("test", 4, 1),
			...fx("test", 5, 1),
		];
		expect(isDirectional({ fixtures: base.slice(1) })).toBe(true);
		const lopsided = [
			...fx("tuning", 1, 11),
			...fx("validation", 2, 10),
			...fx("test", 3, 7),
			...fx("test", 4, 1),
			...fx("test", 5, 1),
		];
		expect(isDirectional({ fixtures: lopsided })).toBe(true);
		const fewRepos = base.map((f) => ({
			...f,
			id: f.id.replace(/r[45]/, "r3"),
		}));
		expect(isDirectional({ fixtures: fewRepos })).toBe(true);
	});
});
