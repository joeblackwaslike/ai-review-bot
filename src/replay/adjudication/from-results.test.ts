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
	} = {},
): StoredCell => ({
	key: {
		strategy: o.strategy ?? "a",
		version: "v1",
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
	opts: { draft?: boolean; lock?: boolean | "wrong"; posted?: boolean } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "fr-"));
	const fixturesDir = join(root, "fixtures");
	mkdirSync(fixturesDir);
	const plan = { ...samplePlan(), draft: opts.draft ? true : undefined };
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
	mk(2, "openai");
	const records = [
		cell([cand("alpha finding about the retry loop here", 2)], {
			fixtureId: "o/r#1",
		}),
		{
			...cell([cand("beta finding about the cache key here", 2)], {
				fixtureId: "o/r#2",
			}),
			provider: "openai" as const,
		},
	];
	if (opts.posted !== false)
		writeFileSync(
			join(store, "results.jsonl"),
			records.map((r) => JSON.stringify(r)).join("\n"),
		);
	const first = vi.fn(async () => ({
		verdict: "real" as const,
		scope: null,
		reason: "r",
	}));
	const judges: AdjudicationJudges = {
		verdictJudges: async () => ({
			first: { family: "openai", model: "m", run: first },
			second: null,
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
	};
	return { base, lines, first };
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

	it("prints no verdict counts for a test-split fixture", async () => {
		const { base, lines } = setup();
		await runResultsAdjudication(base);
		const text = lines.join("\n");
		expect(text).toMatch(/real=1/);
		expect(text.match(/\sreal=/g)).toHaveLength(1);
		expect(text).toContain("judge calls made");
	});
});
