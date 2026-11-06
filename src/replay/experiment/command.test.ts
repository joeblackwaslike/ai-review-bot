import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPullFile, SIMPLE_PATCH } from "../../testing.js";
import type { ReviewStrategy, StrategyResult } from "../strategy.js";
import { makeFixture, makeLabels } from "../testkit.js";
import { type ExperimentDeps, runExperiment } from "./command.js";
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
		loadFixtures: async () => ({
			"o/r#1": {
				fixture: makeFixture([["c1"]], { pull: 1 }),
				labels: makeLabels(),
				fetchDiff: async () => ({
					diff: "d",
					files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
					approximate: false,
				}),
			},
		}),
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
		expect(await call(s, "score", true)).toBe(0);
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
