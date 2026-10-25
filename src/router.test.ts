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
	it("trivial tier → Haiku 5.5, low effort", () => {
		const sel = routeModel(
			{ ...base, additions: 8, deletions: 3, filePaths: ["README.md"] },
			"anthropic",
		);
		expect(sel.provider).toBe("anthropic");
		expect(sel.model).toBe("claude-haiku-5-5");
		expect(sel.effort).toBe("low");
	});

	it("normal tier → Sonnet, medium effort", () => {
		const sel = routeModel(base, "anthropic");
		expect(sel.model).toBe("claude-sonnet-5-5");
		expect(sel.effort).toBe("medium");
	});

	it("complex tier → Sonnet, high effort", () => {
		const sel = routeModel(
			{ ...base, additions: 400, deletions: 150 },
			"anthropic",
		);
		expect(sel.model).toBe("claude-sonnet-5-5");
		expect(sel.effort).toBe("high");
	});

	it("deep tier → Opus 5.5, high effort (xhigh can outlast the 210s agent deadline)", () => {
		const sel = routeModel({ ...base, labels: ["deep-review"] }, "anthropic");
		expect(sel.model).toBe("claude-opus-5-5");
		expect(sel.effort).toBe("high");
	});
});

// ---------------------------------------------------------------------------
// routeModel — OpenAI
// ---------------------------------------------------------------------------

// gpt-6-luna and gpt-6.1-sol are confirmed available on both the API-key
// backend (hosted webhook bots, `ai-review audit`) and the OAuth/subscription
// backend (`ai-review watch`), so routeModel takes no authMode parameter.
describe("routeModel — OpenAI", () => {
	it("trivial tier → gpt-6-luna, none effort", () => {
		const sel = routeModel(
			{ ...base, additions: 8, deletions: 3, filePaths: ["README.md"] },
			"openai",
		);
		expect(sel.provider).toBe("openai");
		expect(sel.model).toBe("gpt-6-luna");
		expect(sel.effort).toBe("none");
	});

	it("normal tier → gpt-6.1-sol, low effort", () => {
		const sel = routeModel(base, "openai");
		expect(sel.model).toBe("gpt-6.1-sol");
		expect(sel.effort).toBe("low");
	});

	it("complex tier → gpt-6.1-sol, high effort", () => {
		const sel = routeModel(
			{ ...base, filePaths: ["src/auth/handler.ts"] },
			"openai",
		);
		expect(sel.model).toBe("gpt-6.1-sol");
		expect(sel.effort).toBe("high");
	});

	it("deep tier → gpt-6.1-sol, xhigh effort (distinguished by effort alone)", () => {
		const sel = routeModel({ ...base, labels: ["deep-review"] }, "openai");
		expect(sel.model).toBe("gpt-6.1-sol");
		expect(sel.effort).toBe("xhigh");
	});
});
