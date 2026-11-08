import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPullFile, SIMPLE_PATCH } from "../../testing.js";
import type { AuditRecord } from "../adjudication/audit.js";
import { labelsHashOf } from "../adjudication/audit-defects.js";
import { VerdictCache } from "../adjudication/cache.js";
import { snapshotId } from "../adjudication/snapshot.js";
import type { ReviewStrategy, StrategyResult } from "../strategy.js";
import { makeFixture, makeLabels } from "../testkit.js";
import {
	defaultPlanFile,
	type ExperimentDeps,
	realExperimentDeps,
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

	it("refuses --final before the marker when a test cell went over budget", async () => {
		const p = plan({
			seed: seedFor(["o/r#1", "test"]),
			fixtures: [{ id: "o/r#1", split: "test", provider: "anthropic" }],
		});
		const s = setup(p);
		s.deps.runStrategy = async (st, i) => ({
			...(await st.run(i)),
			usage: { x: { promptTokens: 400_000, completionTokens: 40_000 } },
		});
		await call(s, "run");
		expect(await call(s, "score", true)).toBe(1);
		expect(s.lines.join("\n")).toMatch(/over budget|over cap/i);
		expect(existsSync(join(s.deps.root, planHash(p), "final.marker"))).toBe(
			false,
		);
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

describe("runExperiment in chained mode", () => {
	const chained = () => plan({ mode: "chained" });

	it("plan prints chains and the estimate", async () => {
		const s = setup(chained(), null);
		expect(await call(s, "plan")).toBe(0);
		const text = s.lines.join("\n");
		expect(text).toMatch(/: 2 chains/);
		expect(text).not.toMatch(/cells/);
		expect(text).toMatch(/anthropic \$0\.02/);
		expect(text).toMatch(/nothing was run/);
	});

	it("run goes through runChains: a later round sees the earlier round's own findings", async () => {
		const s = setup(chained());
		const seen: string[][] = [];
		s.deps.loadFixtures = async () => ({
			"o/r#1": {
				fixture: makeFixture([["c1"], ["c2"]], {
					pull: 1,
					provider: "anthropic",
				}),
				labels: makeLabels(),
				fetchDiff: async () => ({
					diff: "d",
					files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
					approximate: false,
				}),
			},
		});
		s.deps.runStrategy = async (st, i) => {
			if (st.name === "a") seen.push(i.history.ledger.map((e) => e.title));
			return {
				...result(),
				posted: [
					{
						skill: null,
						title: `zebra ${i.round.index}`,
						path: "src/a.ts",
						line: 10,
						severity: "P2",
					},
				],
			};
		};
		expect(await call(s, "run")).toBe(0);
		expect(seen).toEqual([[], ["zebra 0"]]);
	});

	it("score prints recycling and convergence and no verdict", async () => {
		const s = setup(chained());
		expect(await call(s, "run")).toBe(0);
		s.lines.length = 0;
		expect(await call(s, "score")).toBe(0);
		const text = s.lines.join("\n");
		expect(text).toMatch(/chained: recycling and convergence only/);
		expect(text).toMatch(/a \[anthropic\] PRs=1/);
		expect(text).toMatch(/a0 vs a \[anthropic\]/);
		expect(text).toMatch(/no verdict in chained mode/);
		expect(text).not.toMatch(/PARTIAL/);
	});

	it("score marks a partly run chained plan PARTIAL", async () => {
		const s = setup(chained());
		expect(await call(s, "score")).toBe(0);
		expect(s.lines.join("\n")).toMatch(/PARTIAL/);
	});
});

describe("score --final in chained mode", () => {
	it("exits 2 before reading cells and writes no marker", async () => {
		const p = plan({ mode: "chained" });
		const s = setup(p);
		expect(await call(s, "score", true)).toBe(2);
		expect(s.lines.join("\n")).toMatch(/chained plans have no final verdict/);
		expect(existsSync(join(s.deps.root, planHash(p), "final.marker"))).toBe(
			false,
		);
	});
});

describe("realExperimentDeps loadFixtures", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	it("attaches the agreed audit defects for the fixture's labels hash", async () => {
		const fixturesDir = mkdtempSync(join(tmpdir(), "fx-"));
		const adjDir = mkdtempSync(join(tmpdir(), "adj-"));
		dirs.push(fixturesDir, adjDir);
		const fixture = makeFixture([["c1"]], { pull: 1, provider: "anthropic" });
		const labelsText = JSON.stringify(makeLabels());
		const stem = join(fixturesDir, "o__r__1__anthropic");
		writeFileSync(`${stem}.json`, JSON.stringify(fixture));
		writeFileSync(`${stem}.labels.json`, labelsText);
		const judge = { family: "anthropic", model: "m", promptHash: "h" } as const;
		const record: AuditRecord = {
			kind: "audit",
			auditAdded: true,
			status: "agreed",
			path: "src/a.ts",
			line: 7,
			title: "missed defect",
			body: "b",
			first: judge,
			second: null,
		};
		new VerdictCache<AuditRecord>(adjDir).put(
			snapshotId(fixture),
			`audit:${labelsHashOf(labelsText)}:src/a.ts:7:k`,
			record,
		);
		const deps = realExperimentDeps({
			fixturesDir,
			out: () => {},
			adjudicationDir: adjDir,
		});
		const loaded = await deps.loadFixtures(
			plan({
				fixtures: [{ id: "o/r#1", split: "tuning", provider: "anthropic" }],
			}),
		);
		expect(loaded["o/r#1"]?.extraDefects).toEqual([
			{ path: "src/a.ts", line: 7, title: "missed defect" },
		]);
	});
});
