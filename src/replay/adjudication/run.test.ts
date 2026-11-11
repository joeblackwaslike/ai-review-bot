import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GhClient } from "../gh.js";
import type { LabelFile, ReplayFixture } from "../types.js";
import { JudgeUnavailableError } from "./adjudicate.js";
import {
	type AdjudicationCandidate,
	type AdjudicationJudges,
	type AdjudicationRun,
	runAdjudication,
} from "./run.js";

const fixture: ReplayFixture = {
	schemaVersion: 1,
	owner: "o",
	repo: "r",
	pull: 1,
	provider: "anthropic",
	author: "a",
	recordedAt: "2026-01-01T00:00:00Z",
	rounds: [
		{
			index: 0,
			reviewId: 1,
			provider: "anthropic",
			submittedAt: "2026-01-01T00:00:00Z",
			headSha: "h",
			baseSha: "b",
			mergeBase: "b",
			triggerAt: null,
			approximate: false,
			commitsSince: [],
			claims: [],
		},
	],
	threads: [],
	reactions: [],
};

const labels: LabelFile = {
	fixtureId: "fx",
	provisional: false,
	labels: [],
	repeatPairs: [],
	negativePairs: [],
	allowedSuppression: [],
};

const patch = "@@ -1,1 +1,2 @@\n a\n+b";

const client: GhClient = {
	rest: async <T>() =>
		({
			files: [{ filename: "a.ts", status: "modified", patch }],
		}) as T,
	graphql: async <T>() => ({}) as T,
};

const candidate: AdjudicationCandidate = {
	path: "a.ts",
	line: 2,
	title: "Retry delay skipped",
	roundIndex: 0,
};

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "run-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "fx.json"), JSON.stringify(fixture));
	writeFileSync(join(dir, "fx.labels.json"), JSON.stringify(labels));
	const first = vi.fn(async () => ({
		verdict: "not-real" as const,
		scope: null,
		reason: "n",
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
	const lines: string[] = [];
	const base: AdjudicationRun = {
		id: "fx",
		dir,
		caps: { anthropic: 10, openai: 0 },
		plan: false,
		audit: false,
		client,
		out: (s) => lines.push(s),
		cacheDir: mkdtempSync(join(tmpdir(), "run-cache-")),
		judges,
		candidates: () => [candidate],
	};
	return { base, first, lines };
}

describe("runAdjudication hooks", () => {
	it("candidates override replaces the saved-trace source", async () => {
		const { base, first } = setup();
		const code = await runAdjudication(base);
		expect(code).toBe(0);
		expect(first).toHaveBeenCalledTimes(1);
	});

	it("onSpend reports calls made", async () => {
		const { base } = setup();
		const onSpend = vi.fn();
		await runAdjudication({ ...base, onSpend });
		expect(onSpend).toHaveBeenCalledTimes(1);
		expect(onSpend).toHaveBeenCalledWith({ anthropic: 1, openai: 0 });
	});

	it("onSpend reports 0 when everything is cached", async () => {
		const { base } = setup();
		await runAdjudication(base);
		const onSpend = vi.fn();
		await runAdjudication({ ...base, onSpend });
		expect(onSpend).toHaveBeenCalledWith({ anthropic: 0, openai: 0 });
	});

	it("quiet hides verdict counts", async () => {
		const { base, lines } = setup();
		await runAdjudication({ ...base, quiet: true });
		const text = lines.join("\n");
		expect(text).toContain("judge calls made");
		expect(text).not.toMatch(/real=|not-real=|unclear=/);
	});

	it("shows verdict counts by default", async () => {
		const { base, lines } = setup();
		await runAdjudication(base);
		expect(lines.join("\n")).toMatch(/not-real=1/);
	});
});

describe("runAdjudication unavailable judge", () => {
	it("onSpend still reports when the judge is unavailable", async () => {
		const { base } = setup();
		const onSpend = vi.fn();
		const code = await runAdjudication({
			...base,
			onSpend,
			judges: async () => {
				throw new Error("no auth");
			},
		});
		expect(code).toBe(1);
		expect(onSpend).toHaveBeenCalledTimes(1);
		expect(onSpend).toHaveBeenCalledWith({ anthropic: 0, openai: 0 });
	});
});

describe("runAdjudication quiet with a cross-check", () => {
	it("prints no line that reveals verdict counts, onSpend keeps the truth", async () => {
		const { base, lines } = setup();
		const titles = ["Alpha handler drops errors", "Beta cache never expires"];
		const verdictFor = (title: string) =>
			title.startsWith("Alpha")
				? { verdict: "real" as const, scope: "change" as const, reason: "r" }
				: { verdict: "not-real" as const, scope: null, reason: "n" };
		const second = vi.fn(async () => ({
			verdict: "real" as const,
			scope: "change" as const,
			reason: "r",
		}));
		const judges: AdjudicationJudges = {
			verdictJudges: async () => ({
				first: {
					family: "anthropic",
					model: "m",
					run: async (input) => verdictFor(input.claim.title),
				},
				second: { family: "openai", model: "m2", run: second },
			}),
			auditJudges: async () => {
				throw new Error("unused");
			},
		};
		const onSpend = vi.fn();
		await runAdjudication({
			...base,
			judges,
			caps: { anthropic: 10, openai: 10 },
			quiet: true,
			onSpend,
			candidates: () =>
				titles.map((title, i) => ({ ...candidate, title, line: 2 + i * 0 })),
		});
		const text = lines.join("\n");
		expect(text).toContain("judge calls made: anthropic=2");
		expect(text).not.toMatch(/openai=|real|unclear|single-family/);
		expect(onSpend).toHaveBeenCalledWith({ anthropic: 2, openai: 1 });
	});
});

describe("runAdjudication quiet hides judge errors", () => {
	const run = async (secondError: Error) => {
		const { base, lines } = setup();
		const judges: AdjudicationJudges = {
			verdictJudges: async () => ({
				first: {
					family: "anthropic",
					model: "m",
					run: async () => ({
						verdict: "real" as const,
						scope: "change" as const,
						reason: "r",
					}),
				},
				second: {
					family: "openai",
					model: "m2",
					run: async () => {
						throw secondError;
					},
				},
			}),
			auditJudges: async () => {
				throw new Error("unused");
			},
		};
		const onSpend = vi.fn();
		const code = await runAdjudication({
			...base,
			judges,
			caps: { anthropic: 10, openai: 10 },
			quiet: true,
			onSpend,
		});
		return { code, text: lines.join("\n"), onSpend };
	};

	it("hides a normal second-judge error", async () => {
		const { text, onSpend } = await run(new Error("secret-boom"));
		expect(text).not.toMatch(/secret-boom|error samples/);
		expect(onSpend).toHaveBeenCalledTimes(1);
	});

	it("hides a JudgeUnavailableError message and keeps exit 1", async () => {
		const { code, text, onSpend } = await run(
			new JudgeUnavailableError("secret-down"),
		);
		expect(code).toBe(1);
		expect(text).not.toMatch(/secret-down|error samples/);
		expect(text).toContain("judging stopped: a judge was unavailable");
		expect(onSpend).toHaveBeenCalledTimes(1);
	});
});
