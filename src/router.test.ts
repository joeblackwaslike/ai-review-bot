import { describe, expect, it } from "vitest";
import type { RouterContext } from "./router.js";
import { classifyTier, routeModel } from "./router.js";

const base: RouterContext = {
	additions: 10,
	deletions: 5,
	filePaths: ["src/utils.ts"],
	labels: [],
};

// ---------------------------------------------------------------------------
// classifyTier
// ---------------------------------------------------------------------------

describe("classifyTier", () => {
	it("returns trivial for small doc-only diffs", () => {
		expect(
			classifyTier({
				...base,
				additions: 8,
				deletions: 3,
				filePaths: ["README.md", "docs/guide.md"],
			}),
		).toBe("trivial");
	});

	it("returns normal by default for small source diffs", () => {
		expect(classifyTier(base)).toBe("normal");
	});

	it("returns complex when total changed lines exceed 500", () => {
		expect(classifyTier({ ...base, additions: 400, deletions: 150 })).toBe(
			"complex",
		);
	});

	it("returns complex when auth-related file paths are present", () => {
		expect(classifyTier({ ...base, filePaths: ["src/auth/handler.ts"] })).toBe(
			"complex",
		);
	});

	it("returns complex when crypto-related file paths are present", () => {
		expect(classifyTier({ ...base, filePaths: ["lib/crypto/sign.ts"] })).toBe(
			"complex",
		);
	});

	it("returns complex when database migration file paths are present", () => {
		expect(
			classifyTier({ ...base, filePaths: ["db/migrations/0001_init.sql"] }),
		).toBe("complex");
	});

	it("returns deep when deep-review label is present", () => {
		expect(classifyTier({ ...base, labels: ["deep-review"] })).toBe("deep");
	});

	it("deep takes priority over complex (large diff with label)", () => {
		expect(
			classifyTier({
				...base,
				additions: 400,
				deletions: 150,
				labels: ["deep-review"],
			}),
		).toBe("deep");
	});

	it("does not classify as trivial when lines are few but files are source", () => {
		expect(
			classifyTier({
				...base,
				additions: 5,
				deletions: 2,
				filePaths: ["src/main.ts"],
			}),
		).toBe("normal");
	});

	it("does not classify as trivial when lines are many even if doc files", () => {
		expect(
			classifyTier({
				...base,
				additions: 50,
				deletions: 20,
				filePaths: ["README.md"],
			}),
		).toBe("normal");
	});
});

// ---------------------------------------------------------------------------
// routeModel — Anthropic
// ---------------------------------------------------------------------------

describe("routeModel — Anthropic", () => {
	it("trivial tier → Haiku, no thinking budget", () => {
		const sel = routeModel(
			{ ...base, additions: 8, deletions: 3, filePaths: ["README.md"] },
			"anthropic",
		);
		expect(sel.provider).toBe("anthropic");
		expect(sel.model).toBe("claude-haiku-4-5");
		expect(sel.thinkingBudget).toBeUndefined();
	});

	it("normal tier → Sonnet, no thinking budget", () => {
		const sel = routeModel(base, "anthropic");
		expect(sel.model).toBe("claude-sonnet-4-6");
		expect(sel.thinkingBudget).toBeUndefined();
	});

	it("complex tier → Sonnet + thinking budget 8000", () => {
		const sel = routeModel(
			{ ...base, additions: 400, deletions: 150 },
			"anthropic",
		);
		expect(sel.model).toBe("claude-sonnet-4-6");
		expect(sel.thinkingBudget).toBe(8000);
	});

	it("deep tier → Opus + thinking budget 16000", () => {
		const sel = routeModel({ ...base, labels: ["deep-review"] }, "anthropic");
		expect(sel.model).toBe("claude-opus-4-7");
		expect(sel.thinkingBudget).toBe(16000);
	});
});

// ---------------------------------------------------------------------------
// routeModel — OpenAI
// ---------------------------------------------------------------------------

describe("routeModel — OpenAI", () => {
	it("trivial tier → gpt-5, no reasoning effort", () => {
		const sel = routeModel(
			{ ...base, additions: 8, deletions: 3, filePaths: ["README.md"] },
			"openai",
		);
		expect(sel.provider).toBe("openai");
		expect(sel.model).toBe("gpt-5");
		expect(sel.reasoningEffort).toBeUndefined();
	});

	it("normal tier → gpt-5, no reasoning effort", () => {
		const sel = routeModel(base, "openai");
		expect(sel.model).toBe("gpt-5");
		expect(sel.reasoningEffort).toBeUndefined();
	});

	it("complex tier → o4-mini + medium reasoning", () => {
		const sel = routeModel(
			{ ...base, filePaths: ["src/auth/handler.ts"] },
			"openai",
		);
		expect(sel.model).toBe("o4-mini");
		expect(sel.reasoningEffort).toBe("medium");
	});

	it("deep tier → o3 + high reasoning", () => {
		const sel = routeModel({ ...base, labels: ["deep-review"] }, "openai");
		expect(sel.model).toBe("o3");
		expect(sel.reasoningEffort).toBe("high");
	});
});
