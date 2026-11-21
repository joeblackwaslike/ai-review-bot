import { describe, expect, it } from "vitest";
import { WorkBudget } from "./budget.js";

describe("WorkBudget", () => {
	it("returns false and marks exhausted when a limit is exceeded", () => {
		const budget = new WorkBudget({ tokens: 10, candidates: 5, cells: 100 });

		expect(budget.spendTokens(10)).toBe(true);
		expect(budget.exhausted).toBe(false);
		expect(budget.spendTokens(1)).toBe(false);
		expect(budget.exhausted).toBe(true);
	});

	it("does not spend on a refused request", () => {
		const budget = new WorkBudget({ tokens: 10, candidates: 5, cells: 100 });

		expect(budget.spendTokens(7)).toBe(true);
		expect(budget.spendTokens(4)).toBe(false);
		expect(budget.spendTokens(3)).toBe(true);
	});

	it("keeps the three pools separate", () => {
		const budget = new WorkBudget({ tokens: 10, candidates: 5, cells: 100 });

		expect(budget.spendTokens(10)).toBe(true);
		expect(budget.spendCandidates(5)).toBe(true);
		expect(budget.spendCells(100)).toBe(true);
		expect(budget.spendCandidates(1)).toBe(false);
		expect(budget.spendCells(1)).toBe(false);
	});

	it("applies default limits when none are given", () => {
		const budget = new WorkBudget();

		expect(budget.spendTokens(200_000)).toBe(true);
		expect(budget.spendTokens(1)).toBe(false);
		expect(budget.spendCandidates(5_000)).toBe(true);
		expect(budget.spendCandidates(1)).toBe(false);
		expect(budget.spendCells(16_000_000)).toBe(true);
		expect(budget.spendCells(1)).toBe(false);
	});

	it("fills in unspecified limits from defaults when partially overridden", () => {
		const budget = new WorkBudget({ candidates: 2 });

		expect(budget.spendCandidates(2)).toBe(true);
		expect(budget.spendCandidates(1)).toBe(false);
		expect(budget.spendTokens(200_000)).toBe(true);
	});
});
