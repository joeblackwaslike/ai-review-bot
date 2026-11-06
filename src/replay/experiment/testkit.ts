import type { ExperimentPlan } from "./plan.js";

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
	seed: "seed",
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
