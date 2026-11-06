import type { ExperimentPlan } from "./plan.js";
import { type Split, splitOf } from "./splits.js";

/** A seed under which every given fixture id lands in its given split. */
export const seedFor = (...pairs: [id: string, split: Split][]): string => {
	for (let n = 0; n < 100_000; n++) {
		const seed = `seed-${n}`;
		if (pairs.every(([id, split]) => splitOf(id, seed) === split)) return seed;
	}
	throw new Error("no seed found");
};

export const samplePlan = (): ExperimentPlan => ({
	planVersion: 1,
	mode: "per-round",
	strategies: [
		{ name: "a", version: "v1" },
		{ name: "a0", version: "v1" },
	],
	models: { anthropic: "claude-sonnet-5-5" },
	providers: ["anthropic"],
	budgets: {
		maxAnthropicUsd: 10,
		maxOpenAiUsd: 2,
		perCellUsd: 1,
		perCellWallMs: 210_000,
	},
	trials: 1,
	seed: seedFor(["o/r#1", "tuning"], ["o/r#2", "test"]),
	fixtures: [
		{ id: "o/r#1", split: "tuning", provider: "anthropic" },
		{ id: "o/r#2", split: "test", provider: "openai" },
	],
	metrics: ["precision", "recall"],
	thresholds: {
		precisionBootstrap: { level: 0.95, resamples: 1000 },
		maxRecallDropPoints: 5,
		hostedFitShare: 0.9,
		hostedFitSeconds: 210,
	},
	a0Tolerance: 0.1,
	selectionRule: "language and operation spread",
});

/** A plan that clears the 30 PR, 10 per split, 5 repository minimum. */
export const fullSizePlan = (): ExperimentPlan => {
	const base = samplePlan();
	const buckets: Record<Split, string[]> = {
		tuning: [],
		validation: [],
		test: [],
	};
	for (let n = 1; Object.values(buckets).some((b) => b.length < 10); n++) {
		const id = `o/r${n % 6}#${n}`;
		const split = splitOf(id, base.seed);
		if (buckets[split].length < 10) buckets[split].push(id);
	}
	return {
		...base,
		fixtures: (Object.entries(buckets) as [Split, string[]][]).flatMap(
			([split, ids]) =>
				ids.map((id) => ({ id, split, provider: "anthropic" as const })),
		),
	};
};
