import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { planHash } from "../experiment/plan.js";
import type { StoredCell } from "../experiment/store.js";
import { samplePlan } from "../experiment/testkit.js";
import type { GhClient } from "../gh.js";
import { makeFixture, makeLabel, makeLabels } from "../testkit.js";
import type { CandidateRecord, LabelFile, ReplayFixture } from "../types.js";
import { postedCandidates, runResultsAdjudication } from "./from-results.js";
import type { AdjudicationJudges } from "./run.js";

const LABELLED = "retry delay skipped before first attempt";
const OTHER = "cache key ignores tenant identifier value";

const cand = (title: string, line = 1, path = "a.ts"): CandidateRecord => ({
	skill: null,
	title,
	path,
	line,
	severity: null,
});

const cell = (
	posted: CandidateRecord[],
	o: {
		round?: number;
		strategy?: string;
		stale?: boolean;
		fixtureId?: string;
		version?: string;
	} = {},
): StoredCell => ({
	key: {
		strategy: o.strategy ?? "a",
		version: o.version ?? "v1",
		fixtureId: o.fixtureId ?? "o/r#1",
		round: o.round ?? 0,
		trial: 0,
	},
	provider: "anthropic",
	planHash: "h",
	at: "t",
	costUsd: 1,
	fitIn210s: true,
	failedAttempts: 0,
	cacheTemperature: "unknown",
	stale: o.stale ?? false,
	result: {
		findings: [],
		candidates: posted,
		posted,
		agentReviews: [],
		usage: {},
		toolCalls: [],
		wallMs: 1,
	},
});

const fixture = makeFixture([[LABELLED], [OTHER]]);
const labels = makeLabels({ labels: [makeLabel(LABELLED, "fixed")] });

describe("postedCandidates", () => {
	it("drops findings that join a labelled claim", () => {
		const out = postedCandidates(
			[cell([cand(LABELLED), cand("unrelated race in scheduler loop", 40)])],
			fixture,
			labels,
		);
		expect(out.map((c) => c.title)).toEqual([
			"unrelated race in scheduler loop",
		]);
	});

	it("counts a finding once across rounds and strategies", () => {
		const f = cand("unrelated race in scheduler loop", 40);
		const out = postedCandidates(
			[
				cell([f], { round: 1 }),
				cell([f], { round: 0, strategy: "a0" }),
				cell([f], { round: 2 }),
			],
			fixture,
			labels,
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.roundIndex).toBe(0);
	});

	it("ignores stale cells", () => {
		const out = postedCandidates(
			[cell([cand("unrelated race in scheduler loop", 40)], { stale: true })],
			fixture,
			labels,
		);
		expect(out).toEqual([]);
	});
});

const patch = "@@ -1,1 +1,2 @@\n a\n+b";
const client: GhClient = {
	rest: async <T>() =>
		({ files: [{ filename: "a.ts", status: "modified", patch }] }) as T,
	graphql: async <T>() => ({}) as T,
};

function setup(
	opts: {
		draft?: boolean;
		lock?: boolean | "wrong";
		posted?: boolean;
		anthropicBoth?: boolean;
		noTest?: boolean;
		offPatch?: boolean;
		cellVersion?: string;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "fr-"));
	const fixturesDir = join(root, "fixtures");
	mkdirSync(fixturesDir);
	const sample = samplePlan();
	const plan = {
		...sample,
		draft: opts.draft ? true : undefined,
		fixtures: sample.fixtures
			.filter((f) => !(opts.noTest && f.split === "test"))
			.map((f) => ({
				...f,
				provider: opts.anthropicBoth ? ("anthropic" as const) : f.provider,
			})),
	};
	const planFile = join(root, "plan.json");
	writeFileSync(planFile, JSON.stringify(plan));
	const hash = planHash(plan as never);
	if (opts.lock !== false)
		writeFileSync(
			join(root, "plan.lock"),
			opts.lock === "wrong" ? "deadbeefdeadbeef" : hash,
		);
	const store = join(root, "results", hash);
	mkdirSync(store, { recursive: true });
	const lines: string[] = [];
	const mk = (pull: number, provider: "anthropic" | "openai") => {
		const f: ReplayFixture = makeFixture([["x"]], { pull, provider });
		const l: LabelFile = makeLabels({ fixtureId: "fx" });
		const stem = `o__r__${pull}__${provider}`;
		writeFileSync(join(fixturesDir, `${stem}.json`), JSON.stringify(f));
		writeFileSync(join(fixturesDir, `${stem}.labels.json`), JSON.stringify(l));
	};
	mk(1, "anthropic");
	mk(2, opts.anthropicBoth ? "anthropic" : "openai");
	const records = [
		cell(
			[
				cand("alpha finding about the retry loop here", 2),
				cand("gamma real finding about the queue drain", 2),
			],
			{ fixtureId: "o/r#1", version: opts.cellVersion },
		),
		...(opts.offPatch
			? [
					cell([cand("zeta finding in a file with no patch", 1, "other.ts")], {
						fixtureId: "o/r#1",
					}),
				]
			: []),
		...(opts.noTest
			? []
			: [
					cell(
						[
							cand("beta finding about the cache key here", 2),
							cand("delta real finding about the lock order", 2),
							cand("epsilon finding about the log format", 2),
						],
						{ fixtureId: "o/r#2" },
					),
				]),
	];
	if (opts.posted !== false)
		writeFileSync(
			join(store, "results.jsonl"),
			records.map((r) => JSON.stringify(r)).join("\n"),
		);
	const first = vi.fn(async (input: { claim: { title: string } }) => ({
		verdict: input.claim.title.includes("real")
			? ("real" as const)
			: ("not-real" as const),
		scope: null,
		reason: "r",
	}));
	const second = vi.fn(async () => ({
		verdict: "real" as const,
		scope: null,
		reason: "r",
	}));
	const judges: AdjudicationJudges = {
		verdictJudges: async () => ({
			first: { family: "anthropic", model: "m", run: first },
			second: { family: "openai", model: "m2", run: second },
		}),
		auditJudges: async () => {
			throw new Error("unused");
		},
	};
	const base = {
		planFile,
		root: join(root, "results"),
		fixturesDir,
		caps: { anthropic: 10, openai: 0 },
		plan: false,
		client,
		out: (s: string) => lines.push(s),
		cacheDir: mkdtempSync(join(tmpdir(), "fr-cache-")),
		judges,
		registry: (name: string) => ({ name, version: "v1" }) as never,
	};
	return { base, lines, first, second };
}

describe("runResultsAdjudication", () => {
	it("refuses a draft plan", async () => {
		const { base, lines } = setup({ draft: true });
		expect(await runResultsAdjudication(base)).toBe(1);
		expect(lines.join("\n")).toContain("marked draft");
	});

	it("refuses a plan without a matching lock", async () => {
		for (const lock of [false, "wrong"] as const) {
			const { base, lines } = setup({ lock });
			expect(await runResultsAdjudication(base)).toBe(1);
			expect(lines.join("\n")).toMatch(
				/not committed|differs from the committed/,
			);
		}
	});

	it("shares the caps across fixtures", async () => {
		const { base, lines, first } = setup();
		const code = await runResultsAdjudication({
			...base,
			caps: { anthropic: 1, openai: 0 },
		});
		expect(code).toBe(0);
		expect(first).toHaveBeenCalledTimes(1);
		expect(lines.join("\n")).toContain(
			"total judge calls: anthropic=1 openai=0, unjudged (deferred by cap): 1",
		);
	});

	it("counts only cap-deferred candidates, not ones that can never be judged", async () => {
		const { base, lines } = setup({ offPatch: true });
		await runResultsAdjudication({
			...base,
			caps: { anthropic: 10, openai: 0 },
		});
		expect(lines.join("\n")).toContain("not judged");
		expect(lines.join("\n")).toContain("unjudged (deferred by cap): 0");
	});

	it("judges only cells at the registry's version", async () => {
		const { base, first } = setup({ cellVersion: "v0" });
		expect(await runResultsAdjudication(base)).toBe(0);
		expect(first).toHaveBeenCalledTimes(3);
	});

	it("refuses when the registry version differs from the plan's", async () => {
		const { base, lines, first } = setup();
		const code = await runResultsAdjudication({
			...base,
			registry: (name: string) => ({ name, version: "v2" }) as never,
		});
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("differs from the plan's v1");
		expect(first).not.toHaveBeenCalled();
	});

	it("reports an unreadable fixture, keeps going and still prints the total", async () => {
		const { base, lines, first } = setup();
		writeFileSync(join(base.fixturesDir, "o__r__1__anthropic.json"), "{trunc");
		const code = await runResultsAdjudication(base);
		expect(code).toBe(1);
		const text = lines.join("\n");
		expect(text).toMatch(/cannot read fixture\/labels for o\/r#1: .+/);
		expect(first).toHaveBeenCalledTimes(3);
		expect(text).toContain("total judge calls: anthropic=3");
	});

	it("prints no error text for an unreadable test-split fixture", async () => {
		const { base, lines } = setup();
		writeFileSync(join(base.fixturesDir, "o__r__2__openai.json"), "{trunc");
		expect(await runResultsAdjudication(base)).toBe(1);
		expect(lines).toContain("cannot read fixture/labels for o/r#2");
		expect(lines.join("\n")).toContain("total judge calls");
	});

	it("--plan builds no judge", async () => {
		const { base, lines } = setup();
		const judges = vi.fn(async () => {
			throw new Error("must not build");
		});
		const code = await runResultsAdjudication({
			...base,
			plan: true,
			judges,
		});
		expect(code).toBe(0);
		expect(judges).not.toHaveBeenCalled();
		expect(lines.join("\n")).toContain("no model is called");
	});

	it("withholds every detail of a test-split fixture", async () => {
		const { base, lines, second } = setup({ anthropicBoth: true });
		const code = await runResultsAdjudication({
			...base,
			caps: { anthropic: 10, openai: 5 },
		});
		expect(code).toBe(0);
		const i = lines.findIndex((l) => l.includes("(test split)"));
		expect(i).toBeGreaterThan(-1);
		expect(lines[i]).toBe(
			"fixture o/r#2 (test split): verdicts recorded, details hidden until score --final",
		);
		const after = lines.slice(i + 1);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatch(/^total judge calls: anthropic=5 openai=1,/);
		expect(after[0]).toContain(
			"(test-split openai calls and deferred counts withheld)",
		);
		const afterTuning = lines.slice(0, i).join("\n");
		expect(afterTuning).toContain("real=");
		expect(second).toHaveBeenCalledTimes(2);
		const text = lines.slice(i).join("\n");
		for (const word of [
			"single-family",
			"upgrad",
			"unclear",
			"producer model",
			"not judged",
			"real=",
		])
			expect(text).not.toContain(word);
	});

	it("records test-split verdicts in the cache", async () => {
		const { base, first } = setup({ anthropicBoth: true });
		const caps = { anthropic: 10, openai: 5 };
		await runResultsAdjudication({ ...base, caps });
		expect(first).toHaveBeenCalledTimes(5);
		await runResultsAdjudication({ ...base, caps });
		expect(first).toHaveBeenCalledTimes(5);
	});

	it("prints the same for a tuning fixture whether or not a test fixture follows", async () => {
		const withTest = setup({ anthropicBoth: true });
		const without = setup({ anthropicBoth: true, noTest: true });
		const caps = { anthropic: 10, openai: 5 };
		await runResultsAdjudication({ ...withTest.base, caps });
		await runResultsAdjudication({ ...without.base, caps });
		const tuning = (ls: string[]) =>
			ls.slice(
				0,
				ls.findIndex((l) => l.startsWith("total judge calls")),
			);
		const a = tuning(withTest.lines);
		const b = tuning(without.lines);
		expect(a.slice(0, b.length)).toEqual(b);
	});

	it("processes the test split last and lets it share the caps", async () => {
		const { base, lines } = setup({ anthropicBoth: true });
		await runResultsAdjudication({
			...base,
			caps: { anthropic: 2, openai: 0 },
		});
		const t = lines.findIndex((l) => l.includes("(test split)"));
		const v = lines.findIndex((l) => l.startsWith("fixture o/r#1"));
		expect(v).toBeLessThan(t);
		expect(lines.join("\n")).toContain("anthropic=2 openai=0");
	});

	it("--plan prints only candidate and anthropic figures for a test fixture", async () => {
		const { base, lines } = setup({ anthropicBoth: true });
		await runResultsAdjudication({
			...base,
			plan: true,
			caps: { anthropic: 10, openai: 5 },
		});
		const i = lines.findIndex((l) => l.startsWith("fixture o/r#2"));
		const test = lines.slice(i);
		expect(
			test.some((l) => l.includes("distinct unmatched candidates: 3")),
		).toBe(true);
		expect(test.some((l) => l.startsWith("anthropic calls allowed"))).toBe(
			true,
		);
		for (const word of [
			"cached",
			"candidates to judge",
			"openai calls",
			"upgrad",
		])
			expect(test.join("\n")).not.toContain(word);
	});
});
