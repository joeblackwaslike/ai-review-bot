import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPullFile, SIMPLE_PATCH } from "../../testing.js";
import type { ReviewStrategy, StrategyResult } from "../strategy.js";
import { makeFixture, makeLabels } from "../testkit.js";
import {
	defaultPlanFile,
	type ExperimentDeps,
	runExperiment,
} from "./command.js";
import { type ExperimentPlan, planHash } from "./plan.js";
import { fullSizePlan, samplePlan, seedFor } from "./testkit.js";

const result = (): StrategyResult => ({
	findings: [],
	candidates: [],
	posted: [],
	agentReviews: [],
	usage: { x: { promptTokens: 1000, completionTokens: 100 } },
	toolCalls: [],
	wallMs: 10,
});

const stub = (name: string): ReviewStrategy => ({
	name,
	version: "v1",
	needsCheckout: false,
	estimateCost: () => 0.01,
	run: async () => result(),
});

const plan = (over: Partial<ExperimentPlan> = {}): ExperimentPlan => ({
	...samplePlan(),
	seed: seedFor(["o/r#1", "tuning"]),
	fixtures: [{ id: "o/r#1", split: "tuning", provider: "anthropic" }],
	...over,
});

const setup = (p: ExperimentPlan, lock: string | null | "match" = "match") => {
	const dir = mkdtempSync(join(tmpdir(), "exp-"));
	writeFileSync(join(dir, "plan.json"), JSON.stringify(p));
	if (lock !== null)
		writeFileSync(
			join(dir, "plan.lock"),
			`${lock === "match" ? planHash(p) : lock}\n`,
		);
	const lines: string[] = [];
	const registry = new Map([stub("a"), stub("a0")].map((s) => [s.name, s]));
	const deps: ExperimentDeps = {
		out: (s) => lines.push(s),
		root: join(dir, "store"),
		loadFixtures: async () =>
			Object.fromEntries(
				p.fixtures.map((f, i) => [
					f.id,
					{
						fixture: makeFixture([["c1"]], {
							pull: i + 1,
							provider: f.provider,
						}),
						labels: makeLabels(),
						fetchDiff: async () => ({
							diff: "d",
							files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
							approximate: false,
						}),
					},
				]),
			),
		registry: (n) => {
			const s = registry.get(n);
			if (!s) throw new Error(`unknown ${n}`);
			return s;
		},
		runStrategy: (s, i) => s.run(i),
		cache: { get: () => undefined },
		now: () => new Date("2026-11-06T00:00:00Z"),
		modelFor: () => "claude-sonnet-5-5",
	};
	return { file: join(dir, "plan.json"), deps, lines };
};

const call = (
	s: ReturnType<typeof setup>,
	mode: "plan" | "run" | "score",
	final = false,
) => runExperiment({ mode, planFile: s.file, final }, s.deps);

describe("runExperiment", () => {
	it("exits 1 for a missing plan file", async () => {
		const s = setup(plan());
		const code = await runExperiment(
			{
				mode: "plan",
				planFile: join(tmpdir(), "nope", "plan.json"),
				final: false,
			},
			s.deps,
		);
		expect(code).toBe(1);
	});

	it("plan mode prints the estimate and caps, spends nothing, and works without a lock", async () => {
		const s = setup(plan(), null);
		expect(await call(s, "plan")).toBe(0);
		const text = s.lines.join("\n");
		expect(text).toMatch(/2 cells/);
		expect(text).toMatch(/anthropic \$0\.02/);
		expect(text).toMatch(/cap/i);
	});

	it("plan mode exits 1 when a lock exists and differs", async () => {
		const s = setup(plan(), "0000000000000000");
		expect(await call(s, "plan")).toBe(1);
	});

	it("run and score need a matching committed lock and a non-draft plan", async () => {
		expect(await call(setup(plan(), null), "run")).toBe(1);
		expect(await call(setup(plan(), "0000000000000000"), "run")).toBe(1);
		expect(await call(setup(plan({ draft: true })), "run")).toBe(1);
		expect(await call(setup(plan(), null), "score")).toBe(1);
	});

	it("run stores cells and score then reads them without a verdict", async () => {
		const s = setup(plan());
		expect(await call(s, "run")).toBe(0);
		s.lines.length = 0;
		expect(await call(s, "score")).toBe(0);
		expect(s.lines.join("\n")).toMatch(/no verdict outside --final/);
	});

	it("run exits 3 when the grid is partial and 0 when complete", async () => {
		const tight = plan({
			budgets: {
				maxAnthropicUsd: 0.001,
				maxOpenAiUsd: 1,
				perCellUsd: 1,
				perCellWallMs: 210_000,
			},
		});
		expect(await call(setup(tight), "run")).toBe(3);
		expect(await call(setup(plan()), "run")).toBe(0);
	});

	it("run exits 1 when a cell failed", async () => {
		const s = setup(plan());
		s.deps.runStrategy = async () => {
			throw new Error("boom");
		};
		expect(await call(s, "run")).toBe(1);
	});

	it("allows one --final per plan hash", async () => {
		const s = setup(
			plan({
				seed: seedFor(["o/r#1", "test"]),
				fixtures: [{ id: "o/r#1", split: "test", provider: "anthropic" }],
			}),
		);
		expect(await call(s, "run")).toBe(0);
		expect(await call(s, "score", true)).toBe(0);
		expect(await call(s, "score", true)).toBe(1);
	});
});

describe("score --final seed gates", () => {
	const gate = {
		pass: true,
		originalsMissed: 0,
		cleanFindings: 0,
		reasons: [],
	};

	it("refuses before writing the marker when a candidate lacks a seed-gate result", async () => {
		const s = setup(fullSizePlan());
		expect(await call(s, "run")).toBe(0);
		expect(await call(s, "score", true)).toBe(1);
		expect(s.lines.join("\n")).toMatch(/seed gate/i);
		const dir = join(s.deps.root, planHash(fullSizePlan()));
		expect(existsSync(join(dir, "final.marker"))).toBe(false);

		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "seed-gates.json"), JSON.stringify({ a0: gate }));
		expect(await call(s, "score", true)).toBe(0);
		expect(existsSync(join(dir, "final.marker"))).toBe(true);
		expect(await call(s, "score", true)).toBe(1);
	});

	it("needs no seed gates for a directional plan", async () => {
		const s = setup(
			plan({
				seed: seedFor(["o/r#1", "test"]),
				fixtures: [{ id: "o/r#1", split: "test", provider: "anthropic" }],
			}),
		);
		expect(await call(s, "run")).toBe(0);
		expect(await call(s, "score", true)).toBe(0);
	});

	it("refuses --final before the marker when planned test cells are missing", async () => {
		const full = fullSizePlan();
		const s = setup(full);
		const dir = join(s.deps.root, planHash(full));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "seed-gates.json"), JSON.stringify({ a0: gate }));
		expect(await call(s, "score", true)).toBe(1);
		expect(s.lines.join("\n")).toMatch(/missing|partial/i);
		expect(existsSync(join(dir, "final.marker"))).toBe(false);
	});

	it("reads seed-gates.json only for --final", async () => {
		const s = setup(plan());
		const dir = join(s.deps.root, planHash(plan()));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "seed-gates.json"), "{not json");
		expect(await call(s, "run")).toBe(0);
		expect(await call(s, "score")).toBe(0);
	});

	it("rejects a plan without the baseline strategy before scoring", async () => {
		const s = setup(plan({ strategies: [{ name: "a0", version: "v1" }] }));
		expect(await call(s, "score")).toBe(1);
		expect(s.lines.join("\n")).toMatch(/baseline/);
	});

	it("lists each missing cell of a partial run", async () => {
		const s = setup(
			plan({
				budgets: {
					maxAnthropicUsd: 0.001,
					maxOpenAiUsd: 1,
					perCellUsd: 1,
					perCellWallMs: 210_000,
				},
			}),
		);
		expect(await call(s, "run")).toBe(3);
		expect(s.lines.join("\n")).toMatch(/missing a o\/r#1 round 0 trial 0/);
	});

	it("does not burn the marker when scoring throws", async () => {
		const s = setup(
			plan({
				seed: seedFor(["o/r#1", "test"]),
				fixtures: [{ id: "o/r#1", split: "test", provider: "anthropic" }],
			}),
		);
		s.deps.registry = () => {
			throw new Error("boom");
		};
		await expect(call(s, "score", true)).rejects.toThrow("boom");
		const dir = join(
			s.deps.root,
			planHash(
				plan({
					seed: seedFor(["o/r#1", "test"]),
					fixtures: [{ id: "o/r#1", split: "test", provider: "anthropic" }],
				}),
			),
		);
		expect(existsSync(join(dir, "final.marker"))).toBe(false);
	});
});

describe("defaultPlanFile", () => {
	it("is the repo's docs/review-experiments/plan.json, whatever --fixtures says", () => {
		const file = defaultPlanFile(import.meta.url);
		expect(file.endsWith(join("docs", "review-experiments", "plan.json"))).toBe(
			true,
		);
		expect(existsSync(file)).toBe(true);
	});
});
