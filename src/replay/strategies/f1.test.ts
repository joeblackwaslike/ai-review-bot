import { NoObjectGeneratedError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPriceTable } from "../../pricing.js";
import {
	buildInlineComment,
	buildModelReview,
	buildPullFile,
	SIMPLE_PATCH,
} from "../../testing.js";
import {
	TRIAGE_CALL_PREFIX,
	TRIAGE_USAGE_KEY,
} from "../experiment/spend-matched-names.js";
import { type StrategyInput, strategyNames } from "../strategy.js";
import {
	F1_IMPLEMENTATION_REVISION,
	strategyF1,
	strategyF1Version,
} from "./f1.js";
import { loadEntries } from "./f1-runbooks.js";
import { registerBuiltinStrategies } from "./index.js";

const mockRunAgent = vi.hoisted(() => vi.fn());
const mockGenerateObject = vi.hoisted(() => vi.fn());
const haikuPin = vi.hoisted(() => ({ on: true }));
const mockSkillRead = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs", async (orig) => {
	const real = await orig<typeof import("node:fs")>();
	return {
		...real,
		readFileSync: ((path: string, ...rest: never[]) => {
			if (mockSkillRead.fail && String(path).endsWith("f1-triage.md"))
				throw new Error("ENOENT");
			return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
		}) as typeof real.readFileSync,
	};
});
vi.mock("../../review.js", async (orig) => ({
	...(await orig<typeof import("../../review.js")>()),
	runAgent: mockRunAgent,
}));
vi.mock("ai", async (orig) => ({
	...(await orig<typeof import("ai")>()),
	generateObject: mockGenerateObject,
}));
vi.mock("../../config/load.js", async (orig) => {
	const real = await orig<typeof import("../../config/load.js")>();
	return {
		...real,
		getConfigTree: () => ({
			...real.getConfigTree(),
			models: haikuPin.on
				? {
						"anthropic/claude-haiku-5-5": {
							pricing: { input: 1, cachedInput: 0.1, output: 5 },
						},
					}
				: {},
		}),
	};
});
vi.mock("../../roles.js", async (orig) => ({
	...(await orig<typeof import("../../roles.js")>()),
	resolveJudgeRole: () => ({
		provider: "anthropic",
		model: "claude-haiku-5-5",
		effort: "low",
	}),
}));
vi.mock("../../auth.js", () => ({
	resolveAnthropicAuth: vi.fn(async () => ({ provider: "anthropic" })),
	resolveOpenAIAuth: vi.fn(async () => ({})),
}));

const PRICES = {
	"anthropic/claude-sonnet-5-5": { input: 2, cachedInput: 0.2, output: 10 },
	"anthropic/claude-haiku-5-5": { input: 1, cachedInput: 0.1, output: 5 },
};
setPriceTable(PRICES);
const ONE_RUN = { promptTokens: 100_000, completionTokens: 10_000 };
const TRIAGE_USAGE = { inputTokens: 1000, outputTokens: 100 };
const TRIAGE_COST = (1000 * 1 + 100 * 5) / 1_000_000;

const entries = loadEntries();
const [firstId, secondId] = [...entries.keys()] as [string, string];

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

const triageReturns = (operations: string[]) =>
	mockGenerateObject.mockResolvedValue({
		object: { operations },
		usage: TRIAGE_USAGE,
	});

afterEach(() => {
	setPriceTable(PRICES);
});

beforeEach(() => {
	mockRunAgent.mockReset();
	mockRunAgent.mockResolvedValue(okOutcome);
	mockGenerateObject.mockReset();
	triageReturns([firstId, secondId]);
});

describe("strategyF1", () => {
	it("is named f1, needs no checkout and has a stable version", () => {
		expect(strategyF1.name).toBe("f1");
		expect(strategyF1.needsCheckout).toBe(false);
		expect(strategyF1.version).toMatch(/^[0-9a-f]{12}$/);
	});

	it("runs one triage call then reviews with exactly the selected entries in the custom prompt", async () => {
		await strategyF1.run(inputFor());

		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		const prompt = mockGenerateObject.mock.calls[0]?.[0].prompt as string;
		expect(prompt).toContain("Operations:");
		expect(prompt).toContain(firstId);
		expect(mockRunAgent.mock.calls[0]?.[0]).toBe("f1-runbook-reviewer.md");
		const custom = mockRunAgent.mock.calls[0]?.[3] as string;
		expect(custom).toContain(entries.get(firstId));
		expect(custom).toContain(entries.get(secondId));
		for (const [id, text] of entries)
			if (id !== firstId && id !== secondId) expect(custom).not.toContain(text);
	});

	it("triage returning an unknown id or nothing runs the general list and records triage:none", async () => {
		for (const ops of [["ZZZ-99"], []]) {
			mockRunAgent.mockClear();
			triageReturns(ops);
			const out = await strategyF1.run(inputFor());
			expect(out.toolCalls.map((t) => t.name)).toEqual(["triage:none"]);
			expect(mockRunAgent.mock.calls[0]?.[3]).toBe("");
		}
	});

	it("triage returning a failure falls back and records triage:failed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockGenerateObject.mockRejectedValue(new Error("boom"));
		const out = await strategyF1.run(inputFor());
		expect(out.toolCalls.map((t) => t.name)).toEqual(["triage:failed"]);
		expect(out.toolCalls[0]?.costUsd).toBe(0);
		expect(mockRunAgent.mock.calls[0]?.[3]).toBe("");
	});

	it("splits a comma-joined element into ids and injects both entries", async () => {
		triageReturns([`${firstId}, ${secondId}`]);
		const out = await strategyF1.run(inputFor());
		expect(out.toolCalls[0]?.name).toBe(`triage:${firstId},${secondId}`);
		const custom = mockRunAgent.mock.calls[0]?.[3] as string;
		expect(custom).toContain(entries.get(firstId));
		expect(custom).toContain(entries.get(secondId));
	});

	it("books the cost of a failed call that carried usage", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockGenerateObject.mockRejectedValue(
			new NoObjectGeneratedError({
				message: "bad",
				text: "x",
				response: {} as never,
				usage: { inputTokens: 1000, outputTokens: 100 } as never,
				finishReason: "stop",
			}),
		);
		const out = await strategyF1.run(inputFor());
		expect(out.toolCalls[0]?.name).toBe("triage:failed");
		expect(out.toolCalls[0]?.costUsd).toBeCloseTo(TRIAGE_COST, 8);
		expect(out.usage["f1-triage.md"]).toBeDefined();
	});

	it("rethrows a programming error from the triage call", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockGenerateObject.mockRejectedValue(new TypeError("bug"));
		await expect(strategyF1.run(inputFor())).rejects.toThrow(TypeError);
	});

	it("triage runs once and every repeat reuses the selection", async () => {
		await strategyF1.run(inputFor(1000));
		expect(mockRunAgent.mock.calls.length).toBeGreaterThan(1);
		expect(mockGenerateObject).toHaveBeenCalledTimes(1);
		const customs = new Set(mockRunAgent.mock.calls.map((c) => c[3]));
		expect(customs.size).toBe(1);
	});

	it("usage holds f1-triage.md and f1-run-N.md keys and the spend counts the triage cost", async () => {
		const out = await strategyF1.run(inputFor());
		expect(Object.keys(out.usage)).toEqual(["f1-run-1.md", "f1-triage.md"]);
		expect(out.usage["f1-triage.md"]).toMatchObject({
			promptTokens: 1000,
			completionTokens: 100,
		});
		const runCost = (100_000 * 2 + 10_000 * 10) / 1_000_000;
		expect(out.spend?.achievedUsd).toBeCloseTo(runCost + TRIAGE_COST);
		expect(out.agentReviews[0]?.skill).toBe("f1-run-1");
	});

	it("reports the input spend target, not the one reduced by the triage cost", async () => {
		const out = await strategyF1.run(inputFor(0.5));
		expect(out.spend?.targetUsd).toBe(0.5);
	});

	it("counts the triage cost against the spend target so one fewer repeat runs", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { operations: [firstId] },
			usage: { inputTokens: 200_000, outputTokens: 0 },
		});
		const out = await strategyF1.run(inputFor(0.9));
		expect(mockRunAgent).toHaveBeenCalledTimes(2);
		expect(out.toolCalls[0]?.costUsd).toBeCloseTo(0.2, 8);
	});

	it("counts the triage cost against the per-cell cap so no repeat launches", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { operations: [firstId] },
			usage: { inputTokens: 200_000, outputTokens: 0 },
		});
		const input = inputFor(1000);
		input.budget = { maxUsd: 0.7, maxWallMs: 600_000 };
		await strategyF1.run(input);
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
	});

	it("surfaces a pricing failure after a successful triage call", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { operations: [firstId] },
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		setPriceTable({
			"anthropic/claude-sonnet-5-5": PRICES["anthropic/claude-sonnet-5-5"],
		});
		haikuPin.on = false;
		try {
			await expect(strategyF1.run(inputFor())).rejects.toThrow(
				/no price known/,
			);
		} finally {
			haikuPin.on = true;
		}
	});

	it("keeps four ids in order from six ids and a duplicate", async () => {
		const ids = [...entries.keys()].slice(0, 6);
		triageReturns([ids[0] as string, ...ids]);
		const out = await strategyF1.run(inputFor());
		expect(out.toolCalls[0]?.name).toBe(`triage:${ids.slice(0, 4).join(",")}`);
	});

	it("puts the Diff: marker before the diff in the triage prompt", async () => {
		await strategyF1.run(inputFor());
		const prompt = mockGenerateObject.mock.calls[0]?.[0].prompt as string;
		expect(prompt).toContain(`\nDiff:\n${"x".repeat(4000)}`);
	});

	it("records the triage wall time in wallMs and shrinks the wall budget for the loop", async () => {
		mockGenerateObject.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 30));
			return { object: { operations: [firstId] }, usage: TRIAGE_USAGE };
		});
		const out = await strategyF1.run(inputFor(1000));
		expect(out.wallMs).toBeGreaterThanOrEqual(30);
		expect(out.toolCalls[0]?.wallMs).toBeGreaterThanOrEqual(25);
		const tight = inputFor(1000);
		tight.budget = { maxUsd: 1000, maxWallMs: 10 };
		mockRunAgent.mockClear();
		await strategyF1.run(tight);
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
	});

	it("surfaces a missing triage skill file instead of recording triage:failed", async () => {
		mockSkillRead.fail = true;
		try {
			await expect(strategyF1.run(inputFor())).rejects.toThrow("ENOENT");
		} finally {
			mockSkillRead.fail = false;
		}
	});

	it("rethrows when the signal is aborted instead of recording triage:failed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const controller = new AbortController();
		const input = inputFor();
		input.signal = controller.signal;
		mockGenerateObject.mockImplementation(async () => {
			controller.abort();
			throw new Error("aborted");
		});
		await expect(strategyF1.run(input)).rejects.toThrow("aborted");
	});

	it("warns with the fixture id about ids dropped as unknown", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		triageReturns([firstId, "ZZZ-99"]);
		await strategyF1.run(inputFor());
		expect(warn).toHaveBeenCalledWith(
			"f1: triage returned unknown ids",
			expect.objectContaining({ fixture: "o/r", unknown: ["ZZZ-99"] }),
		);
	});

	it("emits the usage key and call prefix the runner prices by", async () => {
		const out = await strategyF1.run(inputFor());
		expect(Object.keys(out.usage)).toContain(TRIAGE_USAGE_KEY);
		expect(out.toolCalls[0]?.name.startsWith(TRIAGE_CALL_PREFIX)).toBe(true);
	});

	it("version changes with the classifier model", () => {
		const read = () => "same";
		const sel = (model: string) =>
			({ provider: "anthropic", model, effort: "low" }) as never;
		expect(
			strategyF1Version(read, "h", 1, 1, sel("claude-haiku-5-5")),
		).not.toBe(strategyF1Version(read, "h", 1, 1, sel("claude-sonnet-5-5")));
	});

	it("toolCalls has one triage entry naming the ids", async () => {
		const out = await strategyF1.run(inputFor());
		expect(out.toolCalls).toHaveLength(1);
		expect(out.toolCalls[0]?.name).toBe(`triage:${firstId},${secondId}`);
		expect(out.toolCalls[0]?.costUsd).toBeCloseTo(TRIAGE_COST, 8);
	});

	it("uses ref replay-f1", async () => {
		await strategyF1.run(inputFor());
		expect(mockRunAgent.mock.calls[0]?.[1]).toContain("- Ref: replay-f1");
	});

	it("version changes with the skill text, the triage skill, the entries hash and the revision", () => {
		const read = (a: string, b: string) => (name: string) =>
			name === "f1-triage.md" ? b : a;
		const base = strategyF1Version(read("one", "t"), "h");
		expect(strategyF1Version(read("one", "t"), "h")).toBe(base);
		expect(strategyF1Version(read("two", "t"), "h")).not.toBe(base);
		expect(strategyF1Version(read("one", "u"), "h")).not.toBe(base);
		expect(strategyF1Version(read("one", "t"), "g")).not.toBe(base);
		expect(
			strategyF1Version(read("one", "t"), "h", F1_IMPLEMENTATION_REVISION + 1),
		).not.toBe(base);
		expect(
			strategyF1Version(read("one", "t"), "h", F1_IMPLEMENTATION_REVISION, 99),
		).not.toBe(base);
	});

	it("registers alongside a, a0 and f0", () => {
		registerBuiltinStrategies();
		expect(strategyNames()).toEqual(
			expect.arrayContaining(["a", "a0", "f0", "f1"]),
		);
	});
});
