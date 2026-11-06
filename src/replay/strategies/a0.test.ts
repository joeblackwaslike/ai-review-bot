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

const inputFor = (maxUsd: number): StrategyInput =>
	({
		fixture: { provider: "anthropic", owner: "o", repo: "r" },
		diff: "x".repeat(4000),
		files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
		history: { ledger: [] },
		budget: { maxUsd, maxWallMs: 600_000 },
		signal: new AbortController().signal,
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
		});
		expect(out.findings.map((f) => f.title).sort()).toEqual(
			mergeReviewsDetailed(out.agentReviews.map((a) => a.review))
				.review.inline_comments.map((c) => c.title)
				.sort(),
		);
	});

	it("runs at least once when the target is below one run", async () => {
		const out = await strategyA0.run(inputFor(oneRunUsd / 100));
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
		expect(out.spend?.withinTolerance).toBe(false);
	});

	it("caps repeats at the maximum", async () => {
		await strategyA0.run(inputFor(oneRunUsd * 1000));
		expect(mockRunAgent).toHaveBeenCalledTimes(10);
	});

	it("flags spend more than 10% off the target", async () => {
		const out = await strategyA0.run(inputFor(oneRunUsd * 2.4));
		expect(mockRunAgent).toHaveBeenCalledTimes(2);
		expect(out.spend?.withinTolerance).toBe(false);
	});

	it("throws when the first run fails", async () => {
		mockRunAgent.mockResolvedValue({ status: "rate_limited", rateLimit: {} });
		await expect(strategyA0.run(inputFor(1))).rejects.toThrow(/a0/);
	});

	it("estimates one run times the target repeat count", () => {
		const one = strategyA0.estimateCost(inputFor(0));
		expect(one).toBeGreaterThan(0);
		expect(strategyA0.estimateCost(inputFor(one * 3))).toBeCloseTo(one * 3);
	});
});
