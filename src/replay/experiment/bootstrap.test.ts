import { describe, expect, it } from "vitest";
import {
	median,
	mulberry32,
	nearestRank,
	pairedBootstrap,
} from "./bootstrap.js";

describe("mulberry32", () => {
	it("repeats for a seed and differs across seeds", () => {
		const a = mulberry32("x");
		const b = mulberry32("x");
		const c = mulberry32("y");
		const seqA = [a(), a(), a()];
		expect(seqA).toEqual([b(), b(), b()]);
		expect(seqA).not.toEqual([c(), c(), c()]);
		for (const v of seqA) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe("nearestRank", () => {
	const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

	it("returns the value at rank ceil(q * n)", () => {
		expect(nearestRank(sorted, 0.5)).toBe(5);
		expect(nearestRank(sorted, 0.95)).toBe(10);
		expect(nearestRank(sorted, 0.25)).toBe(3);
		expect(nearestRank(sorted, 0.1)).toBe(1);
	});

	it("clamps q of 0 and 1 to the ends", () => {
		expect(nearestRank(sorted, 0)).toBe(1);
		expect(nearestRank(sorted, 1)).toBe(10);
	});
});

describe("median", () => {
	it("handles odd, even and empty", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 2, 3])).toBe(2.5);
		expect(median([])).toBeNaN();
	});
});

describe("pairedBootstrap", () => {
	const opts = { level: 0.95, resamples: 2000, seed: "s" };

	it("is deterministic for a seed", () => {
		const pairs = [0.1, 0.3, 0.2, 0.4, 0.25].map((d) => ({
			a: d + 0.5,
			b: 0.5,
		}));
		expect(pairedBootstrap(pairs, opts)).toEqual(pairedBootstrap(pairs, opts));
	});

	it("excludes zero for a consistent positive difference", () => {
		const pairs = Array.from({ length: 12 }, (_, i) => ({
			a: 0.8 + (i % 3) * 0.01,
			b: 0.5,
		}));
		const r = pairedBootstrap(pairs, opts);
		expect(r.lo).toBeGreaterThan(0);
		expect(r.mean).toBeCloseTo(0.31, 1);
		expect(r.n).toBe(12);
	});

	it("includes zero when differences straddle it", () => {
		const pairs = [0.2, -0.2, 0.1, -0.1, 0.3, -0.3].map((d) => ({
			a: 0.5 + d,
			b: 0.5,
		}));
		const r = pairedBootstrap(pairs, opts);
		expect(r.lo).toBeLessThan(0);
		expect(r.hi).toBeGreaterThan(0);
	});

	it("returns NaN bounds for no pairs", () => {
		const r = pairedBootstrap([], opts);
		expect(r.n).toBe(0);
		expect(r.lo).toBeNaN();
	});
});
