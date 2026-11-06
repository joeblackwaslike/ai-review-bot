import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAnthropicAuth, resolveOpenAIAuth } from "../auth.js";
import { computeCost } from "../models.js";
import type { PullFile } from "../review.js";
import {
	buildInlineComment,
	buildModelReview,
	SIMPLE_PATCH,
	TWO_HUNK_PATCH,
} from "../testing.js";
import { freezeFixture } from "./frozen.js";
import type { GhClient } from "./gh.js";
import {
	buildLiveWiring,
	resolveSelectionAuth,
	toLiveFindings,
	toLiveReviewOutput,
} from "./live-wiring.js";
import { runStrategy } from "./run-strategy.js";
import { strategyA } from "./strategies/a.js";
import type { StrategyInput } from "./strategy.js";
import { ledgerForRound } from "./trace.js";
import type { LabelFile, PostedClaim, ReplayFixture, Round } from "./types.js";

const mockRunAuditPass = vi.hoisted(() => vi.fn());
vi.mock("../audit.js", () => ({ runAuditPass: mockRunAuditPass }));
vi.mock("../auth.js", () => ({
	resolveAnthropicAuth: vi.fn(async () => ({})),
	resolveOpenAIAuth: vi.fn(async () => ({})),
}));

describe("toLiveFindings", () => {
	const finding = {
		category: "style" as const,
		confidence: 0.8,
		evidence: "See diff.",
		suppressible: true,
	};

	it("carries body, severity and suppressible from inline and general findings", () => {
		const out = toLiveFindings({
			event: "COMMENT",
			inline_comments: [
				{
					...finding,
					title: "Inline",
					body: "inline body",
					severity: "P2",
					path: "src/a.ts",
					line: 7,
					start_line: null,
					suggestion: null,
				},
			],
			general_findings: [
				{
					...finding,
					title: "General",
					body: "general body",
					severity: "P0",
					suppressible: false,
				},
			],
		});
		expect(out).toEqual([
			{
				title: "Inline",
				path: "src/a.ts",
				line: 7,
				body: "inline body",
				severity: "P2",
				suppressible: true,
			},
			{
				title: "General",
				path: null,
				line: null,
				body: "general body",
				severity: "P0",
				suppressible: false,
			},
		]);
	});
});

describe("resolveSelectionAuth", () => {
	const deps = () => ({
		anthropic: vi.fn().mockResolvedValue({ provider: "anthropic" }),
		openai: vi.fn().mockResolvedValue({ provider: "openai" }),
	});

	it("resolves anthropic and openai selections exactly as before", async () => {
		const d = deps();
		await expect(resolveSelectionAuth("anthropic", d)).resolves.toEqual({
			provider: "anthropic",
		});
		await expect(resolveSelectionAuth("openai", d)).resolves.toEqual({
			provider: "openai",
		});
		expect(d.anthropic).toHaveBeenCalledTimes(1);
		expect(d.openai).toHaveBeenCalledTimes(1);
	});

	it("a google selection with no key names the missing env var and uses no other credential", async () => {
		const d = deps();
		await expect(resolveSelectionAuth("google", d, {})).rejects.toThrow(
			/GOOGLE_GENERATIVE_AI_API_KEY/,
		);
		expect(d.anthropic).not.toHaveBeenCalled();
		expect(d.openai).not.toHaveBeenCalled();
	});

	it("a google selection with a key resolves to the registry path", async () => {
		const d = deps();
		await expect(
			resolveSelectionAuth("google", d, { GOOGLE_GENERATIVE_AI_API_KEY: "k" }),
		).resolves.toBeUndefined();
	});
});

describe("strategy a review auth", () => {
	const inputFor = (reviewer: string, provider: string): StrategyInput =>
		({
			fixture: { owner: "o", repo: "r", provider, reviewer },
			round: { index: 0 },
			diff: "diff",
			files: [],
			history: { ledger: [] },
			budget: { maxUsd: 5, maxWallMs: 1000 },
			signal: new AbortController().signal,
		}) as unknown as StrategyInput;

	const withGoogleKey = async (
		key: string | undefined,
		body: () => Promise<void>,
	) => {
		const saved = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
		if (key === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
		else process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
		try {
			await body();
		} finally {
			if (saved === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
			else process.env.GOOGLE_GENERATIVE_AI_API_KEY = saved;
		}
	};

	beforeEach(() => {
		mockRunAuditPass.mockReset();
		vi.mocked(resolveAnthropicAuth).mockClear();
		vi.mocked(resolveOpenAIAuth).mockClear();
		mockRunAuditPass.mockResolvedValue({
			review: buildModelReview(),
			agentReviews: [],
			usageBySkill: {},
			agentsAttempted: 0,
			agentsSucceeded: 0,
		});
	});

	it("a google selection with no key errors naming the env var and receives no other provider's credentials", async () => {
		await withGoogleKey(undefined, async () => {
			await expect(strategyA.run(inputFor("gemini", "google"))).rejects.toThrow(
				/GOOGLE_GENERATIVE_AI_API_KEY/,
			);
			expect(resolveAnthropicAuth).not.toHaveBeenCalled();
			expect(resolveOpenAIAuth).not.toHaveBeenCalled();
			expect(mockRunAuditPass).not.toHaveBeenCalled();
		});
	});

	it("a google selection with a key runs with undefined auth", async () => {
		await withGoogleKey("k", async () => {
			await strategyA.run(inputFor("gemini", "google"));
			expect(mockRunAuditPass.mock.calls[0]?.[0].auth).toBeUndefined();
			expect(resolveAnthropicAuth).not.toHaveBeenCalled();
			expect(resolveOpenAIAuth).not.toHaveBeenCalled();
		});
	});

	it("legacy anthropic and openai fixtures resolve their own auth as before", async () => {
		vi.mocked(resolveAnthropicAuth).mockResolvedValueOnce({
			provider: "anthropic",
		} as never);
		await strategyA.run(inputFor("claude", "anthropic"));
		expect(mockRunAuditPass.mock.calls[0]?.[0].auth).toEqual({
			provider: "anthropic",
		});
		vi.mocked(resolveOpenAIAuth).mockResolvedValueOnce({
			provider: "openai",
		} as never);
		await strategyA.run(inputFor("codex", "openai"));
		expect(mockRunAuditPass.mock.calls[1]?.[0].auth).toEqual({
			provider: "openai",
		});
	});
});

describe("toLiveReviewOutput", () => {
	const base = {
		category: "style" as const,
		confidence: 0.8,
		evidence: "See diff.",
		suppressible: true,
	};
	const review = (inline: string[], general: string[]) => ({
		event: "COMMENT" as const,
		inline_comments: inline.map((title, i) => ({
			...base,
			title,
			body: "b",
			severity: "P2" as const,
			path: "src/a.ts",
			line: i + 1,
			start_line: null,
			suggestion: null,
		})),
		general_findings: general.map((title) => ({
			...base,
			title,
			body: "b",
			severity: "P3" as const,
		})),
	});

	it("keeps the optional cached and reasoning token fields", () => {
		const usageBySkill = {
			"code-reviewer": {
				promptTokens: 3,
				completionTokens: 1,
				cachedInputTokens: 2,
				reasoningTokens: 1,
			},
		};
		const out = toLiveReviewOutput({
			review: review([], []),
			agentReviews: [],
			usageBySkill,
		});
		expect(out.usage["code-reviewer.md"]).toEqual(
			usageBySkill["code-reviewer"],
		);
	});

	it("tags candidates with each agent's skill, one per inline and general finding, in agent order", () => {
		const usageBySkill = {
			"code-reviewer": { promptTokens: 3, completionTokens: 1 },
		};
		const out = toLiveReviewOutput({
			review: review(["A"], []),
			agentReviews: [
				{ skill: "code-reviewer", review: review(["A", "B"], ["G"]) },
				{ skill: "security-sast", review: review([], ["H"]) },
			],
			usageBySkill,
		});
		expect(out.candidates).toEqual([
			{
				skill: "code-reviewer.md",
				title: "A",
				path: "src/a.ts",
				line: 1,
				severity: "P2",
			},
			{
				skill: "code-reviewer.md",
				title: "B",
				path: "src/a.ts",
				line: 2,
				severity: "P2",
			},
			{
				skill: "code-reviewer.md",
				title: "G",
				path: null,
				line: null,
				severity: "P3",
			},
			{
				skill: "security-sast.md",
				title: "H",
				path: null,
				line: null,
				severity: "P3",
			},
		]);
		expect(out.findings.map((f) => f.title)).toEqual(["A"]);
		expect(out.usage).toEqual({
			"code-reviewer.md": { promptTokens: 3, completionTokens: 1 },
		});
	});
});

describe("buildLiveWiring", () => {
	const settled: PostedClaim = {
		id: "r0:c1:0",
		roundIndex: 0,
		reviewId: 1,
		source: "inline",
		commentId: 1,
		path: "src/a.ts",
		line: 2,
		severity: "P1",
		title: "Token cache never expires",
		text: "Entries in `tokenCache` are never evicted.",
	};
	const round = (index: number, claims: PostedClaim[]): Round => ({
		index,
		reviewId: index + 1,
		provider: "anthropic",
		submittedAt: `2026-10-0${index + 1}T12:00:00Z`,
		headSha: `h${index}`,
		baseSha: "b",
		mergeBase: `m${index}`,
		triggerAt: `2026-10-0${index + 1}T11:00:00Z`,
		approximate: false,
		commitsSince: [],
		claims,
	});
	const fixture = {
		owner: "o",
		repo: "r",
		provider: "anthropic",
		threads: [],
		reactions: [],
		rounds: [round(0, [settled]), round(1, [])],
	} as unknown as ReplayFixture;
	const labels = {
		labels: [
			{
				claimId: settled.id,
				label: "rejected",
				confidence: "high",
				evidence: ["2026-10-01T18:00:00Z|Intentional."],
				confirmed: true,
			},
		],
		repeatPairs: [],
	} as unknown as LabelFile;

	const inputFor = (
		f: ReplayFixture,
		target: Round,
		fetched: { diff: string; files: PullFile[]; approximate: boolean },
	): StrategyInput => ({
		fixture: freezeFixture(f, target.index),
		round: target,
		diff: fetched.diff,
		files: fetched.files,
		approximateDiff: fetched.approximate,
		checkout: null,
		history: { ledger: ledgerForRound(f, labels, target) },
		budget: { maxUsd: 5, maxWallMs: 210_000 },
		signal: new AbortController().signal,
	});

	it("fetches the round's compare files once and reports what would post against the fixture's earlier rounds", async () => {
		const routes: string[] = [];
		const client = {
			rest: async (route: string) => {
				routes.push(route);
				return {
					files: [
						{ filename: "src/a.ts", status: "modified", patch: SIMPLE_PATCH },
					],
				};
			},
		} as unknown as GhClient;
		const fresh = buildInlineComment({
			title: "Retry loop never gives up",
			path: "src/a.ts",
			line: 3,
		});
		const agentReview = buildModelReview({
			inline_comments: [
				buildInlineComment({
					title: settled.title,
					body: settled.text,
					path: "src/a.ts",
					line: 2,
				}),
				fresh,
				buildInlineComment({
					title: "Unchecked index",
					path: "src/a.ts",
					line: 9,
				}),
			],
		});
		mockRunAuditPass.mockResolvedValue({
			review: agentReview,
			agentReviews: [{ skill: "code-reviewer", review: agentReview }],
			usageBySkill: {},
		});
		const wiring = buildLiveWiring(fixture, client);
		const target = fixture.rounds[1] as Round;

		const fetched = await wiring.fetchDiff(target);
		const output = await runStrategy(
			strategyA,
			inputFor(fixture, target, fetched),
		);

		expect(output.posted).toEqual([
			{
				skill: "code-reviewer.md",
				title: fresh.title,
				path: "src/a.ts",
				line: 3,
				severity: "P2",
			},
		]);
		expect(output.candidates).toHaveLength(3);
		expect(routes).toEqual(["repos/o/r/compare/m1...h1"]);
		await wiring.fetchDiff(target);
		expect(routes).toHaveLength(1);
	});

	it("shows the agents each compare patch with right-side line numbers", async () => {
		const routes: string[] = [];
		const client = {
			rest: async (route: string) => {
				routes.push(route);
				return {
					files: [
						{ filename: "src/b.ts", status: "modified", patch: TWO_HUNK_PATCH },
					],
				};
			},
		} as unknown as GhClient;
		const empty = buildModelReview();
		mockRunAuditPass.mockResolvedValue({
			review: empty,
			agentReviews: [],
			usageBySkill: {},
		});
		const wiring = buildLiveWiring(fixture, client);
		const target = fixture.rounds[1] as Round;

		const fetched = await wiring.fetchDiff(target);
		await strategyA.run(inputFor(fixture, target, fetched));

		const expected = [
			"--- src/b.ts",
			"@@ -1,2 +1,3 @@",
			"   1| line1",
			"   2|+line2",
			"   3| line3",
			"@@ -8,2 +9,4 @@",
			"   9| context",
			"  10|+added-a",
			"  11|+added-b",
			"  12| context2",
		].join("\n");
		expect(fetched.diff).toBe(expected);
		expect(fetched.approximate).toBe(false);
		expect(fetched.files.map((f) => f.filename)).toEqual(["src/b.ts"]);
		expect(mockRunAuditPass.mock.lastCall?.[0].files).toEqual([
			{ path: "replay.diff", content: expected },
		]);
		expect(routes).toHaveLength(1);
	});

	it("marks the diff approximate when the round has no merge base", async () => {
		const client = {
			rest: async () => ({ files: [] }),
		} as unknown as GhClient;
		const target = { ...round(1, []), mergeBase: null };
		const wiring = buildLiveWiring(fixture, client);
		expect((await wiring.fetchDiff(target)).approximate).toBe(true);
	});

	describe("model routing per round", () => {
		const added = (n: number) =>
			`@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line${i}`).join("\n")}`;
		const openaiFixture = {
			...fixture,
			provider: "openai",
		} as unknown as ReplayFixture;
		const compareByHead: Record<
			string,
			{ filename: string; status: string; patch: string }[]
		> = {
			h0: [{ filename: "README.md", status: "modified", patch: added(3) }],
			h1: [{ filename: "src/a.ts", status: "modified", patch: added(30) }],
			h2: Array.from({ length: 12 }, (_, i) => ({
				filename: `src/f${i}.ts`,
				status: "modified",
				patch: `${added(45)}\n-old${i}`,
			})),
			// Compare patches carry no file headers, so a deleted "-- note" line
			// starts with "---" and is still a deletion.
			h3: [
				{
					filename: "README.md",
					status: "modified",
					patch: `${added(15)}\n${Array.from({ length: 6 }, (_, i) => `--- note ${i}`).join("\n")}`,
				},
			],
		};
		const client = {
			rest: async (route: string) => ({
				files: compareByHead[route.split("...")[1] as string],
			}),
		} as unknown as GhClient;

		it.each([
			[0, { model: "gpt-6-luna", effort: "none" }],
			[1, { model: "gpt-6.1-sol", effort: "low" }],
			[2, { model: "gpt-6.1-sol", effort: "high" }],
			[3, { model: "gpt-6.1-sol", effort: "low" }],
		])("round %i reviews and estimates with the model its real diff size routes to", async (index, expected) => {
			mockRunAuditPass.mockResolvedValue({
				review: buildModelReview(),
				agentReviews: [],
				usageBySkill: {},
			});
			const target = round(index, []);
			const wiring = buildLiveWiring(
				{ ...openaiFixture, rounds: [target] } as ReplayFixture,
				client,
			);

			const fetched = await wiring.fetchDiff(target);
			const { diff } = fetched;
			const input = inputFor(
				{ ...openaiFixture, rounds: [target] } as ReplayFixture,
				target,
				fetched,
			);
			const estimate = strategyA.estimateCost(input);
			await strategyA.run(input);

			expect(mockRunAuditPass.mock.lastCall?.[0].selection).toMatchObject({
				provider: "openai",
				...expected,
			});
			expect(estimate).toBe(
				computeCost(
					{
						promptTokens: (diff.length / 4) * 5,
						completionTokens: 2000 * 5,
					},
					expected.model,
				),
			);
			expect(estimate).toBeGreaterThan(0);
		});
	});
});
