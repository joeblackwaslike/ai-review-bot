import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeReviewsDetailed } from "../../review.js";
import {
	buildInlineComment,
	buildModelReview,
	buildPullFile,
	SIMPLE_PATCH,
} from "../../testing.js";
import { roundCostUsd } from "../cost.js";
import type { StrategyInput } from "../strategy.js";
import { strategyA0, strategyA0Version } from "./a0.js";

const mockRunAgent = vi.hoisted(() => vi.fn());
vi.mock("../../review.js", async (orig) => ({
	...(await orig<typeof import("../../review.js")>()),
	runAgent: mockRunAgent,
}));
vi.mock("../../auth.js", () => ({
	resolveAnthropicAuth: vi.fn(async () => ({})),
	resolveOpenAIAuth: vi.fn(async () => ({})),
}));

const MODEL = "claude-sonnet-5-5";
const ONE_RUN = { promptTokens: 100_000, completionTokens: 10_000 };
const oneRunUsd = roundCostUsd({ x: ONE_RUN }, MODEL);

const inputFor = (
	target?: number,
	over: {
		maxUsd?: number;
		maxWallMs?: number;
		signal?: AbortSignal;
	} = {},
): StrategyInput =>
	({
		fixture: { provider: "anthropic", owner: "o", repo: "r" },
		diff: "x".repeat(4000),
		files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
		history: { ledger: [] },
		spendTargetUsd: target,
		budget: {
			maxUsd: over.maxUsd ?? 1000,
			maxWallMs: over.maxWallMs ?? 600_000,
		},
		signal: over.signal ?? new AbortController().signal,
	}) as unknown as StrategyInput;

const okOutcome = (title: string) => ({
	status: "ok" as const,
	review: buildModelReview({
		inline_comments: [buildInlineComment({ title, path: "src/a.ts", line: 2 })],
	}),
	usage: ONE_RUN,
	durationMs: 1,
});

beforeEach(() => {
	mockRunAgent.mockReset();
	let k = 0;
	mockRunAgent.mockImplementation(async () => okOutcome(`finding ${++k}`));
});

describe("strategyA0", () => {
	it("is named a0, needs no checkout and has a stable version", () => {
		expect(strategyA0.name).toBe("a0");
		expect(strategyA0.needsCheckout).toBe(false);
		expect(strategyA0.version).toMatch(/^[0-9a-f]{12}$/);
	});

	it("changes version when the skill text changes", () => {
		const read = (text: string) => () => text;
		expect(strategyA0Version(read("one"))).toBe(strategyA0Version(read("one")));
		expect(strategyA0Version(read("one"))).not.toBe(
			strategyA0Version(read("two")),
		);
	});

	it("runs 3 times when the target is 3x one run, each repeat its own group", async () => {
		const out = await strategyA0.run(inputFor(oneRunUsd * 3));

		expect(mockRunAgent).toHaveBeenCalledTimes(3);
		expect(mockRunAgent.mock.calls[0]?.[0]).toBe("a0-single-reviewer.md");
		expect(out.agentReviews.map((a) => a.skill)).toEqual([
			"a0-run-1",
			"a0-run-2",
			"a0-run-3",
		]);
		expect(Object.keys(out.usage)).toEqual([
			"a0-run-1.md",
			"a0-run-2.md",
			"a0-run-3.md",
		]);
		expect(out.spend).toEqual({
			targetUsd: oneRunUsd * 3,
			achievedUsd: oneRunUsd * 3,
			withinTolerance: true,
			failedAttempts: 0,
		});
		expect(out.findings.map((f) => f.title).sort()).toEqual(
			mergeReviewsDetailed(out.agentReviews.map((a) => a.review))
				.review.inline_comments.map((c) => c.title)
				.sort(),
		);
	});

	it("runs exactly once and reports no target when spendTargetUsd is absent", async () => {
		const out = await strategyA0.run(inputFor(undefined, { maxUsd: 1000 }));
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
		expect(out.spend?.targetUsd).toBeNull();
		expect(out.spend?.withinTolerance).toBe(false);
	});

	it("ignores budget.maxUsd as a target", async () => {
		await strategyA0.run(inputFor(undefined, { maxUsd: oneRunUsd * 50 }));
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
	});

	it("sizes the repeats from the warm second run, not the cold first", async () => {
		const warm = {
			promptTokens: 100_000,
			completionTokens: 10_000,
			cachedInputTokens: 90_000,
		};
		const warmUsd = roundCostUsd({ x: warm }, MODEL);
		let k = 0;
		mockRunAgent.mockImplementation(async () => ({
			...okOutcome(`f${++k}`),
			usage: k === 1 ? ONE_RUN : warm,
		}));
		const target = oneRunUsd + warmUsd * 5;
		const out = await strategyA0.run(inputFor(target));
		expect(mockRunAgent).toHaveBeenCalledTimes(6);
		expect(out.spend?.withinTolerance).toBe(true);
	});

	it("stops after two runs when they already meet the target", async () => {
		await strategyA0.run(inputFor(oneRunUsd * 1.8));
		expect(mockRunAgent).toHaveBeenCalledTimes(2);
	});

	it("never launches a repeat that would pass budget.maxUsd", async () => {
		await strategyA0.run(inputFor(oneRunUsd * 10, { maxUsd: oneRunUsd * 3.5 }));
		expect(mockRunAgent).toHaveBeenCalledTimes(3);
	});

	it("always allows the first run even when it exceeds maxUsd", async () => {
		await strategyA0.run(inputFor(oneRunUsd * 10, { maxUsd: oneRunUsd / 10 }));
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
	});

	it("counts failed runs' usage and failedAttempts", async () => {
		let k = 0;
		mockRunAgent.mockImplementation(async () =>
			++k === 3
				? {
						status: "error",
						failure: { class: "unknown" },
						usage: ONE_RUN,
						durationMs: 1,
					}
				: okOutcome(`f${k}`),
		);
		const out = await strategyA0.run(inputFor(oneRunUsd * 3));
		expect(out.spend?.failedAttempts).toBe(1);
		expect(out.spend?.achievedUsd).toBeCloseTo(oneRunUsd * 3);
		expect(Object.keys(out.usage)).toHaveLength(3);
		expect(out.agentReviews).toHaveLength(2);
	});

	it("passes the abort signal and stops launching once aborted", async () => {
		const ctl = new AbortController();
		let k = 0;
		mockRunAgent.mockImplementation(async () => {
			if (++k === 2) ctl.abort();
			return okOutcome(`f${k}`);
		});
		await strategyA0.run(inputFor(oneRunUsd * 8, { signal: ctl.signal }));
		expect(mockRunAgent).toHaveBeenCalledTimes(2);
		expect(mockRunAgent.mock.calls[0]?.[4]).toMatchObject({
			abortSignal: ctl.signal,
		});
	});

	it("stops launching once maxWallMs has elapsed", async () => {
		mockRunAgent.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 15));
			return okOutcome("f");
		});
		await strategyA0.run(inputFor(oneRunUsd * 8, { maxWallMs: 10 }));
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
	});

	it("throws when the first run fails", async () => {
		mockRunAgent.mockResolvedValue({ status: "rate_limited", rateLimit: {} });
		await expect(strategyA0.run(inputFor(oneRunUsd))).rejects.toThrow(/a0/);
	});

	it("estimates one run without a target and one run times repeats with one", () => {
		const one = strategyA0.estimateCost(inputFor(undefined));
		expect(one).toBeGreaterThan(0);
		expect(strategyA0.estimateCost(inputFor(one * 3))).toBeCloseTo(one * 3);
	});
});
