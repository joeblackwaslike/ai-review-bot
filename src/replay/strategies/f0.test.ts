import { beforeEach, describe, expect, it, vi } from "vitest";
import { setPriceTable } from "../../pricing.js";
import { mergeReviewsDetailed } from "../../review.js";
import {
	buildInlineComment,
	buildModelReview,
	buildPullFile,
	SIMPLE_PATCH,
} from "../../testing.js";
import { type StrategyInput, strategyNames } from "../strategy.js";
import { strategyA0 } from "./a0.js";
import {
	F0_IMPLEMENTATION_REVISION,
	strategyF0,
	strategyF0Version,
} from "./f0.js";
import { registerBuiltinStrategies } from "./index.js";

const mockRunAgent = vi.hoisted(() => vi.fn());
vi.mock("../../review.js", async (orig) => ({
	...(await orig<typeof import("../../review.js")>()),
	runAgent: mockRunAgent,
}));
vi.mock("../../auth.js", () => ({
	resolveAnthropicAuth: vi.fn(async () => ({})),
	resolveOpenAIAuth: vi.fn(async () => ({})),
}));

setPriceTable({
	"anthropic/claude-sonnet-5-5": { input: 2, cachedInput: 0.2, output: 10 },
});
const ONE_RUN = { promptTokens: 100_000, completionTokens: 10_000 };

const inputFor = (target?: number): StrategyInput =>
	({
		fixture: { provider: "anthropic", owner: "o", repo: "r" },
		diff: "x".repeat(4000),
		files: [buildPullFile("src/a.ts", SIMPLE_PATCH)],
		history: { ledger: [] },
		spendTargetUsd: target,
		budget: { maxUsd: 1000, maxWallMs: 600_000 },
		signal: new AbortController().signal,
	}) as unknown as StrategyInput;

const okOutcome = {
	status: "ok" as const,
	review: buildModelReview({
		inline_comments: [
			buildInlineComment({ title: "finding", path: "src/a.ts", line: 2 }),
		],
	}),
	usage: ONE_RUN,
	durationMs: 1,
};

beforeEach(() => {
	mockRunAgent.mockReset();
	mockRunAgent.mockResolvedValue(okOutcome);
});

describe("strategyF0", () => {
	it("is named f0, needs no checkout and has a stable version", () => {
		expect(strategyF0.name).toBe("f0");
		expect(strategyF0.needsCheckout).toBe(false);
		expect(strategyF0.version).toMatch(/^[0-9a-f]{12}$/);
	});

	it("changes version with the skill text and the revision", () => {
		const read = (text: string) => () => text;
		expect(strategyF0Version(read("one"))).toBe(strategyF0Version(read("one")));
		expect(strategyF0Version(read("one"))).not.toBe(
			strategyF0Version(read("two")),
		);
		expect(strategyF0Version(read("one"), F0_IMPLEMENTATION_REVISION)).toBe(
			strategyF0Version(read("one")),
		);
		expect(
			strategyF0Version(read("one"), F0_IMPLEMENTATION_REVISION + 1),
		).not.toBe(strategyF0Version(read("one")));
	});

	it("repeats to the spend target like a0, labelling each run f0-run-N", async () => {
		const out = await strategyF0.run(inputFor(1000));

		expect(mockRunAgent.mock.calls.length).toBeGreaterThan(1);
		expect(mockRunAgent.mock.calls[0]?.[0]).toBe("f0-runbook-reviewer.md");
		expect(out.agentReviews[0]?.skill).toBe("f0-run-1");
		expect(Object.keys(out.usage)[0]).toBe("f0-run-1.md");
		expect(out.spend?.targetUsd).toBe(1000);
		expect(out.findings.map((f) => f.title)).toEqual(
			mergeReviewsDetailed(
				out.agentReviews.map((a) => a.review),
			).review.inline_comments.map((c) => c.title),
		);
	});

	it("uses its own message ref so it never reads a's prompt cache", async () => {
		await strategyF0.run(inputFor());
		expect(mockRunAgent.mock.calls[0]?.[1]).toContain("- Ref: replay-f0");
	});

	it("changes version when only the a0 revision changes", () => {
		const read = () => "same";
		expect(strategyF0Version(read, F0_IMPLEMENTATION_REVISION, 1)).not.toBe(
			strategyF0Version(read, F0_IMPLEMENTATION_REVISION, 2),
		);
	});

	it("throws on a non-ok outcome", async () => {
		mockRunAgent.mockResolvedValue({
			status: "quota_exhausted",
			provider: "anthropic",
		});
		await expect(strategyF0.run(inputFor())).rejects.toThrow(
			/^f0 first run failed: quota_exhausted$/,
		);
	});

	it("estimates the same spend-matched cost as a0", () => {
		const input = inputFor(1000);
		expect(strategyF0.estimateCost(input)).toBe(strategyA0.estimateCost(input));
	});

	it("records no tool calls, only run usage keys and an empty custom prompt", async () => {
		const out = await strategyF0.run(inputFor(1000));
		expect(out.toolCalls).toEqual([]);
		for (const key of Object.keys(out.usage))
			expect(key).toMatch(/^f0-run-\d+\.md$/);
		for (const call of mockRunAgent.mock.calls) expect(call[3]).toBe("");
	});

	it("makes one call when no spend target is set", async () => {
		const out = await strategyF0.run(inputFor());
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
		expect(out.agentReviews.map((a) => a.skill)).toEqual(["f0-run-1"]);
	});

	it("registers alongside a and a0", () => {
		registerBuiltinStrategies();
		expect(strategyNames()).toEqual(expect.arrayContaining(["a", "a0", "f0"]));
	});
});
