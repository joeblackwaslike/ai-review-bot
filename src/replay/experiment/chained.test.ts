import { describe, expect, it } from "vitest";
import { setPriceTable } from "../../pricing.js";
import { buildPullFile, SIMPLE_PATCH } from "../../testing.js";
import { requireCost, roundCostUsd } from "../cost.js";
import type {
	ReviewStrategy,
	StrategyInput,
	StrategyResult,
} from "../strategy.js";
import { makeFixture, makeLabels } from "../testkit.js";
import { planChains, runChains } from "./chained.js";
import type { RunnerDeps } from "./runner.js";
import type { CellKey, CellRecord } from "./store.js";
import { cellId } from "./store.js";
import { samplePlan } from "./testkit.js";

setPriceTable({
	"anthropic/claude-sonnet-5-5": { input: 2, cachedInput: 0.2, output: 10 },
});
const USAGE = { x: { promptTokens: 100_000, completionTokens: 10_000 } };
const MODEL = "claude-sonnet-5-5";
const ONE = requireCost(roundCostUsd(USAGE, MODEL), MODEL);

const WORDS = ["zebra", "quartz", "mango"];
const titleOf = (name: string, round: number) =>
	`${name} ${WORDS[round]} issue`;

const finding = (title: string, line: number) => ({
	skill: null,
	title,
	path: "src/a.ts",
	line,
	severity: "P2",
});

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
	run: async (i: StrategyInput) => ({
		...result(),
		posted: [finding(titleOf(name, i.round.index), 100 * (i.round.index + 1))],
	}),
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

const loaded = (pull: number, rounds = 3) => ({
	fixture: makeFixture(
		Array.from({ length: rounds }, () => []),
		{ pull, provider: "anthropic" },
	),
	labels: makeLabels(),
	fetchDiff: async () => ({
		diff: "d",
		files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
		approximate: false,
	}),
});

interface Call {
	strategy: string;
	fixture: number;
	round: number;
	input: StrategyInput;
}

const harness = (
	strategies: ReviewStrategy[],
	over: Partial<RunnerDeps> = {},
	initial: CellRecord[] = [],
) => {
	const calls: Call[] = [];
	const store = memoryStore(initial);
	const byName = new Map(strategies.map((s) => [s.name, s]));
	const deps: RunnerDeps = {
		registry: (n) => byName.get(n) as ReviewStrategy,
		fixtures: { "o/r#1": loaded(1), "o/r#2": loaded(2) },
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
		now: () => new Date("2026-11-07T00:00:00Z"),
		modelFor: () => MODEL,
		out: () => {},
		...over,
	};
	return { deps, calls, store };
};

const plan = (over: Partial<ReturnType<typeof samplePlan>> = {}) => ({
	...samplePlan(),
	mode: "chained" as const,
	strategies: [{ name: "a", version: "v1" }],
	fixtures: [
		{ id: "o/r#1", split: "tuning" as const, provider: "anthropic" as const },
		{
			id: "o/r#2",
			split: "validation" as const,
			provider: "anthropic" as const,
		},
	],
	budgets: {
		maxAnthropicUsd: 1000,
		maxOpenAiUsd: 1000,
		perCellUsd: 100,
		perCellWallMs: 210_000,
	},
	...over,
});

const titlesOf = (c: Call) => c.input.history.ledger.map((e) => e.title);

describe("planChains", () => {
	it("lists one chain per strategy, fixture and trial and sums its rounds", async () => {
		const { deps } = harness([stub("a")]);
		const p = await planChains(plan({ trials: 2 }), deps);
		expect(p.chains).toHaveLength(4);
		expect(p.chains.every((c) => c.rounds === 3)).toBe(true);
		expect(p.estimate.anthropic).toBeCloseTo(ONE * 12);
	});
});

describe("runChains", () => {
	it("a chain feeds a round's posted findings into the next round's ledger", async () => {
		const { deps, calls } = harness([stub("a")]);
		await runChains(plan({ fixtures: [plan().fixtures[0] as never] }), deps);
		const byRound = calls.map(titlesOf);
		expect(byRound[0]).toEqual([]);
		expect(byRound[1]).toEqual([titleOf("a", 0)]);
		expect(byRound[2]).toEqual([titleOf("a", 1)]);
	});

	it("stores each round with key.round set to its index", async () => {
		const { deps, store } = harness([stub("a")]);
		const report = await runChains(plan(), deps, "H");
		expect(report.ran).toBe(6);
		expect(store.records.map((r) => r.key.round).sort()).toEqual([
			0, 0, 1, 1, 2, 2,
		]);
		expect(store.records.every((r) => r.planHash === "H")).toBe(true);
	});

	it("a chain stops at a failing round and lists the later rounds as missing", async () => {
		const flaky = stub("a", {
			run: async (i) => {
				if (i.round.index === 1) throw new Error("boom");
				return result();
			},
		});
		const { deps } = harness([flaky]);
		const report = await runChains(
			plan({ fixtures: [plan().fixtures[0] as never] }),
			deps,
		);
		expect(report.ran).toBe(1);
		expect(report.failed.map((f) => f.round)).toEqual([1]);
		expect(report.missing.map((m) => m.round)).toEqual([2]);
		expect(report.partial).toBe(true);
	});

	it("a resumed chain skips stored rounds and rebuilds its history from them", async () => {
		const first = harness([stub("a")]);
		const one = plan({ fixtures: [plan().fixtures[0] as never] });
		await runChains(one, first.deps);
		const stored = first.store.records.filter((r) => r.key.round < 1);
		const { deps, calls } = harness([stub("a")], {}, stored);
		const report = await runChains(one, deps);
		expect(report.skippedExisting).toBe(1);
		expect(report.ran).toBe(2);
		expect(calls.map((c) => c.round)).toEqual([1, 2]);
		expect(titlesOf(calls[0] as Call)).toEqual([titleOf("a", 0)]);
		expect(titlesOf(calls[1] as Call)).toEqual([titleOf("a", 1)]);
	});

	it("a0 targets a's cost for the same round in the chain", async () => {
		const { deps, calls } = harness([stub("a"), stub("a0")]);
		await runChains(
			plan({
				strategies: [
					{ name: "a", version: "v1" },
					{ name: "a0", version: "v1" },
				],
				fixtures: [plan().fixtures[0] as never],
			}),
			deps,
		);
		const a0 = calls.filter((c) => c.strategy === "a0");
		expect(a0).toHaveLength(3);
		for (const c of a0) expect(c.input.spendTargetUsd).toBeCloseTo(ONE);
		expect(calls.map((c) => `${c.round}.${c.strategy}`)).toEqual([
			"0.a",
			"0.a0",
			"1.a",
			"1.a0",
			"2.a",
			"2.a0",
		]);
		expect(titlesOf(a0[1] as Call)).toEqual([titleOf("a0", 0)]);
	});

	it("an exhausted provider cap stops that provider's chains only", async () => {
		const mixed = plan({
			fixtures: [
				{
					id: "o/r#1",
					split: "tuning" as const,
					provider: "anthropic" as const,
				},
				{
					id: "o/r#2@openai",
					split: "test" as const,
					provider: "openai" as const,
				},
			],
			budgets: {
				maxAnthropicUsd: ONE * 1.5,
				maxOpenAiUsd: 1000,
				perCellUsd: 100,
				perCellWallMs: 210_000,
			},
		});
		const { deps } = harness([stub("a")], {
			fixtures: {
				"o/r#1": loaded(1),
				"o/r#2@openai": {
					...loaded(2),
					fixture: makeFixture([[], [], []], { pull: 2, provider: "openai" }),
				},
			},
			modelFor: () => MODEL,
		});
		const report = await runChains(mixed, deps);
		expect(report.missing.filter((m) => m.fixtureId === "o/r#1")).toHaveLength(
			2,
		);
		expect(report.missing.some((m) => m.fixtureId === "o/r#2@openai")).toBe(
			false,
		);
		expect(report.ran).toBeGreaterThanOrEqual(1);
	});
});
