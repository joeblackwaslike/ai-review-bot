import { describe, expect, it, vi } from "vitest";
import { buildPullFile, SIMPLE_PATCH } from "../../testing.js";
import { roundCostUsd } from "../cost.js";
import type {
	ReviewStrategy,
	StrategyInput,
	StrategyResult,
} from "../strategy.js";
import { makeFixture, makeLabels } from "../testkit.js";
import { planGrid, type RunnerDeps, runGrid } from "./runner.js";
import type { CellKey, CellRecord } from "./store.js";
import { cellId } from "./store.js";
import { samplePlan } from "./testkit.js";

const USAGE = { x: { promptTokens: 100_000, completionTokens: 10_000 } };
const MODEL = "claude-sonnet-5-5";
const ONE = roundCostUsd(USAGE, MODEL);

const result = (): StrategyResult => ({
	findings: [],
	candidates: [],
	posted: [],
	agentReviews: [],
	usage: USAGE,
	toolCalls: [],
	wallMs: 1000,
});

const stub = (
	name: string,
	over: Partial<ReviewStrategy> = {},
): ReviewStrategy => ({
	name,
	version: "v1",
	needsCheckout: false,
	estimateCost: () => ONE,
	run: async () => result(),
	...over,
});

const memoryStore = (initial: CellRecord[] = []) => {
	const records = [...initial];
	return {
		records,
		append: (r: CellRecord) => void records.push(r),
		hasCell: (k: CellKey) => records.some((r) => cellId(r.key) === cellId(k)),
		readAll: () => ({
			records: records.map((r) => ({ ...r, stale: false })),
			skipped: 0,
		}),
	};
};

const loaded = (
	pull: number,
	provider: "anthropic" | "openai" = "anthropic",
) => ({
	fixture: makeFixture([["c1"], ["c2"]], { pull, provider }),
	labels: makeLabels(),
	fetchDiff: async () => ({
		diff: "d",
		files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
		approximate: false,
	}),
});

interface Harness {
	deps: RunnerDeps;
	calls: {
		strategy: string;
		fixture: number;
		round: number;
		input: StrategyInput;
	}[];
	store: ReturnType<typeof memoryStore>;
}

const harness = (
	strategies: ReviewStrategy[],
	over: Partial<RunnerDeps> = {},
	initial: CellRecord[] = [],
): Harness => {
	const calls: Harness["calls"] = [];
	const store = memoryStore(initial);
	const byName = new Map(strategies.map((s) => [s.name, s]));
	const deps: RunnerDeps = {
		registry: (n) => {
			const s = byName.get(n);
			if (!s) throw new Error(`unknown ${n}`);
			return s;
		},
		fixtures: { "o/r#1": loaded(1), "o/r#2": loaded(2), "o/r#3": loaded(3) },
		runStrategy: async (s, input) => {
			calls.push({
				strategy: s.name,
				fixture: input.fixture.pull,
				round: input.round.index,
				input,
			});
			return s.run(input);
		},
		store,
		now: () => new Date("2026-11-06T00:00:00Z"),
		modelFor: () => MODEL,
		out: () => {},
		...over,
	};
	return { deps, calls, store };
};

const plan = (over: Partial<ReturnType<typeof samplePlan>> = {}) => ({
	...samplePlan(),
	fixtures: [
		{ id: "o/r#1", split: "tuning" as const, provider: "anthropic" as const },
		{
			id: "o/r#2",
			split: "validation" as const,
			provider: "anthropic" as const,
		},
		{ id: "o/r#3", split: "test" as const, provider: "anthropic" as const },
	],
	budgets: {
		maxAnthropicUsd: 1000,
		maxOpenAiUsd: 1000,
		perCellUsd: 100,
		perCellWallMs: 210_000,
	},
	...over,
});

const order = (calls: Harness["calls"]) =>
	calls.map((c) => `${c.fixture}.${c.round}.${c.strategy}`);

describe("planGrid", () => {
	it("orders units from the seed and reports the estimate per provider", async () => {
		const { deps } = harness([stub("a"), stub("a0")]);
		const first = await planGrid(plan({ seed: "s1" }), deps);
		const again = await planGrid(plan({ seed: "s1" }), deps);
		expect(first.cells).toEqual(again.cells);
		expect(first.cells).toHaveLength(3 * 2 * 2);
		expect(first.estimate.anthropic).toBeCloseTo(ONE * 12);
		expect(first.estimate.openai).toBe(0);
	});

	it("keeps both strategies of a round together, a before a0", async () => {
		const { deps } = harness([stub("a0"), stub("a")]);
		const { cells } = await planGrid(plan(), deps);
		for (let i = 0; i < cells.length; i += 2) {
			expect(cells[i]?.strategy).toBe("a");
			expect(cells[i + 1]?.strategy).toBe("a0");
			expect(cells[i]?.fixtureId).toBe(cells[i + 1]?.fixtureId);
			expect(cells[i]?.round).toBe(cells[i + 1]?.round);
		}
	});

	it("throws when a registered version differs from the plan", async () => {
		const { deps } = harness([stub("a", { version: "other" }), stub("a0")]);
		await expect(planGrid(plan(), deps)).rejects.toThrow(/version/);
	});
});

describe("runGrid", () => {
	it("runs the same order for the same seed", async () => {
		const one = harness([stub("a"), stub("a0")]);
		const two = harness([stub("a"), stub("a0")]);
		await runGrid(plan({ seed: "same" }), one.deps);
		await runGrid(plan({ seed: "same" }), two.deps);
		expect(order(one.calls)).toEqual(order(two.calls));
		expect(one.calls).toHaveLength(12);
	});

	it("runs a before a0 and gives a0 a's cost and the plan tolerance", async () => {
		const { deps, calls } = harness([stub("a0"), stub("a")]);
		await runGrid(plan({ a0Tolerance: 0.25 }), deps);
		for (let i = 0; i < calls.length; i += 2) {
			expect(calls[i]?.strategy).toBe("a");
			expect(calls[i + 1]?.strategy).toBe("a0");
			expect(calls[i + 1]?.input.spendTargetUsd).toBeCloseTo(ONE);
			expect(calls[i + 1]?.input.tolerance).toBe(0.25);
			expect(calls[i]?.input.spendTargetUsd).toBeUndefined();
		}
	});

	it("stops at the provider cap and lists the missing cells as partial", async () => {
		const { deps, calls, store } = harness([stub("a"), stub("a0")]);
		const report = await runGrid(
			plan({
				budgets: {
					maxAnthropicUsd: ONE * 3.5,
					maxOpenAiUsd: 10,
					perCellUsd: 100,
					perCellWallMs: 210_000,
				},
			}),
			deps,
		);
		expect(calls).toHaveLength(3);
		expect(store.records).toHaveLength(3);
		expect(report.partial).toBe(true);
		expect(report.missing).toHaveLength(12 - 3);
		expect(report.spentUsd.anthropic).toBeCloseTo(ONE * 3);
	});

	it("skips a cell whose estimate passes the per-cell cap", async () => {
		const { deps, calls } = harness([
			stub("a", { estimateCost: () => 5 }),
			stub("a0"),
		]);
		const report = await runGrid(
			plan({
				budgets: {
					maxAnthropicUsd: 1000,
					maxOpenAiUsd: 10,
					perCellUsd: 1,
					perCellWallMs: 210_000,
				},
			}),
			deps,
		);
		expect(calls.filter((c) => c.strategy === "a")).toHaveLength(0);
		expect(report.overCellCap.length).toBeGreaterThan(0);
		expect(report.partial).toBe(true);
	});

	it("refuses an OpenAI cell off the test split without running it", async () => {
		const { deps, calls } = harness([stub("a")], {
			fixtures: { "o/r#1": loaded(1, "openai") },
		});
		const report = await runGrid(
			plan({
				strategies: [{ name: "a", version: "v1" }],
				providers: ["anthropic", "openai"],
				fixtures: [{ id: "o/r#1", split: "validation", provider: "openai" }],
			}),
			deps,
		);
		expect(calls).toHaveLength(0);
		expect(report.refused).toHaveLength(2);
	});

	it("runs OpenAI cells on the test split and counts them against the OpenAI cap", async () => {
		const { deps, calls } = harness([stub("a")], {
			fixtures: { "o/r#1": loaded(1, "openai") },
			modelFor: () => "gpt-5.5",
		});
		const report = await runGrid(
			plan({
				strategies: [{ name: "a", version: "v1" }],
				providers: ["anthropic", "openai"],
				fixtures: [{ id: "o/r#1", split: "test", provider: "openai" }],
				budgets: {
					maxAnthropicUsd: 1000,
					maxOpenAiUsd: 0.0001,
					perCellUsd: 100,
					perCellWallMs: 210_000,
				},
			}),
			deps,
		);
		expect(calls).toHaveLength(0);
		expect(report.missing).toHaveLength(2);
		expect(report.partial).toBe(true);
	});

	it("skips cells already stored and resumes", async () => {
		const first = harness([stub("a"), stub("a0")]);
		await runGrid(plan(), first.deps);
		const second = harness([stub("a"), stub("a0")], {}, first.store.records);
		const report = await runGrid(plan(), second.deps);
		expect(second.calls).toHaveLength(0);
		expect(report.skippedExisting).toBe(12);
		expect(report.partial).toBe(false);
	});

	it("uses a stored a cost as the a0 target on resume", async () => {
		const first = harness([stub("a")]);
		await runGrid(
			plan({ strategies: [{ name: "a", version: "v1" }] }),
			first.deps,
		);
		const second = harness([stub("a"), stub("a0")], {}, first.store.records);
		await runGrid(plan(), second.deps);
		expect(second.calls.every((c) => c.strategy === "a0")).toBe(true);
		expect(second.calls[0]?.input.spendTargetUsd).toBeCloseTo(ONE);
	});

	it("lists rounds without a checkout as unavailable, not failed", async () => {
		const withCheckout = vi.fn(async () => ({
			unavailable: true as const,
			reason: "no sha",
		}));
		const { deps, calls } = harness(
			[stub("a", { needsCheckout: true }), stub("a0")],
			{ withCheckout: withCheckout as unknown as RunnerDeps["withCheckout"] },
		);
		const report = await runGrid(plan(), deps);
		expect(calls.filter((c) => c.strategy === "a")).toHaveLength(0);
		expect(report.unavailable).toHaveLength(6);
		expect(report.failed).toHaveLength(0);
	});

	it("records the cell with cost, fit and timestamp", async () => {
		const { deps, store } = harness([stub("a"), stub("a0")]);
		await runGrid(plan(), deps);
		const rec = store.records[0] as CellRecord;
		expect(rec.costUsd).toBeCloseTo(ONE);
		expect(rec.fitIn210s).toBe(true);
		expect(rec.at).toBe("2026-11-06T00:00:00.000Z");
		expect(rec.provider).toBe("anthropic");
	});

	it("requires a when a0 is planned", async () => {
		const { deps } = harness([stub("a0")]);
		await expect(
			runGrid(plan({ strategies: [{ name: "a0", version: "v1" }] }), deps),
		).rejects.toThrow(/requires "a"/);
	});
});
