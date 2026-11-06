import { describe, expect, it } from "vitest";
import { repeatsForBudget, withinTolerance } from "./a0-repeats.js";

const base = { tolerance: 0.1, max: 10 };

describe("repeatsForBudget", () => {
	it("picks 3 when the target is 3x one run", () => {
		expect(repeatsForBudget({ ...base, targetUsd: 0.3, perRunUsd: 0.1 })).toBe(
			3,
		);
	});

	it("picks the integer closest to the target", () => {
		expect(repeatsForBudget({ ...base, targetUsd: 0.34, perRunUsd: 0.1 })).toBe(
			3,
		);
		expect(repeatsForBudget({ ...base, targetUsd: 0.36, perRunUsd: 0.1 })).toBe(
			4,
		);
	});

	it("runs at least once when the target is below one run", () => {
		expect(repeatsForBudget({ ...base, targetUsd: 0.01, perRunUsd: 0.1 })).toBe(
			1,
		);
		expect(repeatsForBudget({ ...base, targetUsd: 0, perRunUsd: 0.1 })).toBe(1);
	});

	it("caps at max", () => {
		expect(repeatsForBudget({ ...base, targetUsd: 100, perRunUsd: 0.1 })).toBe(
			10,
		);
	});

	it("runs once when a run costs nothing", () => {
		expect(repeatsForBudget({ ...base, targetUsd: 1, perRunUsd: 0 })).toBe(1);
	});
});

describe("withinTolerance", () => {
	it("is true inside the band and false outside", () => {
		expect(withinTolerance(0.105, 0.1, 0.1)).toBe(true);
		expect(withinTolerance(0.09, 0.1, 0.1)).toBe(true);
		expect(withinTolerance(0.2, 0.1, 0.1)).toBe(false);
		expect(withinTolerance(0.05, 0.1, 0.1)).toBe(false);
	});

	it("is false for a non-positive target", () => {
		expect(withinTolerance(0.1, 0, 0.1)).toBe(false);
	});
});
