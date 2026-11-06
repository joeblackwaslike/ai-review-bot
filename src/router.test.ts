import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfigTree, resetConfigForTests } from "./config/load.js";
import type { Config } from "./config/schema.js";
import { SKILL_NAMES } from "./skill-names.js";

const pins = vi.hoisted(() => ({
	models: undefined as Record<string, unknown> | undefined,
}));
vi.mock("./config/load.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./config/load.js")>();
	return {
		...real,
		getConfigTree: () => {
			const tree = real.getConfigTree();
			return pins.models ? { ...tree, models: pins.models } : tree;
		},
	};
});

import type { RouterContext } from "./router.js";
import {
	cheapSelection,
	classifyTier,
	outputBudget,
	reasoningProviderOptions,
	resolveFinderModel,
	resolveSkillModel,
	routeModel,
	routeReviewerModel,
	shouldRunOnTier,
} from "./router.js";

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

describe("classifyTier with custom routing thresholds", () => {
	const routing = {
		...getConfigTree().routing,
		complexLines: 30,
		trivialDocLines: 5,
		deepLabel: "audit-deep",
	};

	it("honors a custom complexLines threshold at the boundary", () => {
		expect(
			classifyTier({ ...base, additions: 20, deletions: 10 }, routing),
		).toBe("normal");
		expect(
			classifyTier({ ...base, additions: 20, deletions: 11 }, routing),
		).toBe("complex");
	});

	it("honors a custom trivialDocLines threshold at the boundary", () => {
		expect(
			classifyTier(
				{ ...base, additions: 3, deletions: 1, filePaths: ["README.md"] },
				routing,
			),
		).toBe("trivial");
		expect(
			classifyTier(
				{ ...base, additions: 3, deletions: 2, filePaths: ["README.md"] },
				routing,
			),
		).toBe("normal");
	});

	it("honors a custom deepLabel", () => {
		expect(classifyTier({ ...base, labels: ["audit-deep"] }, routing)).toBe(
			"deep",
		);
		expect(classifyTier({ ...base, labels: ["deep-review"] }, routing)).toBe(
			"normal",
		);
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

describe("routeModel matches the pre-config tier maps", () => {
	const contexts: Record<string, RouterContext> = {
		trivial: {
			...base,
			additions: 8,
			deletions: 3,
			filePaths: ["README.md"],
		},
		normal: base,
		complex: { ...base, additions: 400, deletions: 150 },
		deep: { ...base, labels: ["deep-review"] },
	};
	const claude = {
		trivial: ["claude-haiku-5-5", "low"],
		normal: ["claude-sonnet-5-5", "medium"],
		complex: ["claude-sonnet-5-5", "high"],
		deep: ["claude-opus-5-5", "high"],
	};
	const codex = {
		trivial: ["gpt-6-luna", "none"],
		normal: ["gpt-6.1-sol", "low"],
		complex: ["gpt-6.1-sol", "high"],
		deep: ["gpt-6.1-sol", "xhigh"],
	};

	it.each(Object.keys(contexts))("%s tier, both providers", (tier) => {
		const ctx = contexts[tier];
		const [cm, ce] = claude[tier as keyof typeof claude];
		const [xm, xe] = codex[tier as keyof typeof codex];
		expect(routeModel(ctx, "anthropic")).toEqual({
			provider: "anthropic",
			model: cm,
			effort: ce,
		});
		expect(routeModel(ctx, "openai")).toEqual({
			provider: "openai",
			model: xm,
			effort: xe,
		});
	});

	it("a sensitive path routes to complex", () => {
		expect(
			routeModel({ ...base, filePaths: ["src/auth/x.ts"] }, "anthropic").effort,
		).toBe("high");
	});
});

describe("classifyTier handles empty sensitivePathPatterns and docExtensions", () => {
	const routing = {
		...getConfigTree().routing,
		sensitivePathPatterns: [],
		docExtensions: [],
	};

	it("no pattern marks a path sensitive", () => {
		expect(
			classifyTier({ ...base, filePaths: ["src/auth/handler.ts"] }, routing),
		).toBe("normal");
	});

	it("empty docExtensions means no file counts as docs", () => {
		expect(classifyTier({ ...base, filePaths: ["README.md"] }, routing)).toBe(
			"normal",
		);
	});
});

describe("classifyTier sensitive patterns are case-insensitive, doc extensions are not", () => {
	const routing = {
		...getConfigTree().routing,
		sensitivePathPatterns: ["Auth/", "SECURITY"],
	};

	it("matches a mixed-case pattern against a lowercase path", () => {
		expect(
			classifyTier({ ...base, filePaths: ["src/auth/handler.ts"] }, routing),
		).toBe("complex");
	});

	it("matches a mixed-case pattern against a mixed-case path", () => {
		expect(
			classifyTier({ ...base, filePaths: ["src/Security/token.ts"] }, routing),
		).toBe("complex");
	});

	it("matches doc extensions exactly as written: README.MD is normal, README.md is trivial", () => {
		const docs = getConfigTree().routing;
		const small = { ...base, additions: 8, deletions: 3 };
		expect(classifyTier({ ...small, filePaths: ["README.MD"] }, docs)).toBe(
			"normal",
		);
		expect(classifyTier({ ...small, filePaths: ["README.md"] }, docs)).toBe(
			"trivial",
		);
	});
});

describe("reasoningProviderOptions adds fallbacks only for refusalFallback models", () => {
	it("opus and sonnet get fallbacks", () => {
		for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
			expect(
				reasoningProviderOptions({
					provider: "anthropic",
					model,
					effort: "high",
				}),
			).toEqual({ anthropic: { effort: "high", fallbacks: "default" } });
		}
	});

	it("haiku does not", () => {
		expect(
			reasoningProviderOptions({
				provider: "anthropic",
				model: "claude-haiku-5-5",
				effort: "low",
			}),
		).toEqual({ anthropic: { effort: "low" } });
	});

	it("OpenAI forwards reasoningEffort including 'none'; undefined effort returns undefined", () => {
		expect(
			reasoningProviderOptions({
				provider: "openai",
				model: "gpt-6-luna",
				effort: "none",
			}),
		).toEqual({ openai: { reasoningEffort: "none" } });
		expect(
			reasoningProviderOptions({ provider: "openai", model: "gpt-6-luna" }),
		).toBeUndefined();
	});
});

describe("reasoningProviderOptions for google", () => {
	afterEach(() => {
		pins.models = undefined;
	});
	const selection = {
		provider: "google",
		model: "gemini-3.8-flash",
		effort: "high",
	} as const;

	it("defaults to a thinking level", () => {
		expect(reasoningProviderOptions(selection)).toEqual({
			google: {
				thinkingConfig: { thinkingLevel: "high", includeThoughts: false },
			},
		});
	});

	it("uses a budget when the model entry says so", () => {
		pins.models = { "google/gemini-3.8-flash": { effortControl: "budget" } };
		expect(reasoningProviderOptions(selection)).toEqual({
			google: {
				thinkingConfig: { thinkingBudget: 24576, includeThoughts: false },
			},
		});
	});

	it("merges the entry's providerOptions over the computed block", () => {
		pins.models = {
			"google/gemini-3.8-flash": {
				providerOptions: { google: { thinkingConfig: { thinkingBudget: 42 } } },
			},
		};
		expect(reasoningProviderOptions(selection)).toEqual({
			google: { thinkingConfig: { thinkingBudget: 42 } },
		});
	});
});

describe("resolveFinderModel", () => {
	const config = getConfigTree();

	it("throws naming the reviewer when the reviewer is unknown", () => {
		expect(() => resolveFinderModel(config, "nonexistent", "normal")).toThrow(
			/unknown reviewer "nonexistent"/,
		);
	});

	it("throws naming the missing tier, distinct from the unknown-reviewer message, when the reviewer exists but has no entry for the tier", () => {
		const { normal, ...remainingTiers } = config.reviewers.claude.tiers;
		const configMissingTier = {
			...config,
			reviewers: {
				...config.reviewers,
				claude: {
					...config.reviewers.claude,
					tiers: remainingTiers,
				},
			},
		} as unknown as typeof config;
		expect(() =>
			resolveFinderModel(configMissingTier, "claude", "normal"),
		).toThrow(/reviewer "claude" has no model configured for tier "normal"/);
	});

	it("throws naming the offending value when the model id has no provider/ prefix", () => {
		const configBadModel = {
			...config,
			reviewers: {
				...config.reviewers,
				claude: {
					...config.reviewers.claude,
					tiers: {
						...config.reviewers.claude.tiers,
						normal: {
							...config.reviewers.claude.tiers.normal,
							model: "claude-sonnet-5-5",
						},
					},
				},
			},
		} as unknown as typeof config;
		expect(() =>
			resolveFinderModel(configBadModel, "claude", "normal"),
		).toThrow(
			/reviewer "claude" tier "normal" model "claude-sonnet-5-5" must be in "provider\/model" form/,
		);
	});
});

describe("routeModel rejects a mismatched provider", () => {
	afterEach(() => {
		delete process.env.AI_REVIEW_REVIEWERS__CLAUDE__TIERS__NORMAL__MODEL;
		resetConfigForTests();
	});

	it("throws when the claude reviewer's tier names an openai model", () => {
		process.env.AI_REVIEW_REVIEWERS__CLAUDE__TIERS__NORMAL__MODEL =
			"openai/gpt-6.1-sol";
		resetConfigForTests();
		expect(() => routeModel(base, "anthropic")).toThrow(
			/reviewer "claude" tier "normal" model "openai\/gpt-6\.1-sol" must use provider "anthropic"/,
		);
	});
});

describe("outputBudget", () => {
	it.each([
		["none" as const, 4096, 4096],
		["low" as const, 4096, 32768],
		["high" as const, 4096, 32768],
		[undefined, 4096, 32768],
		["none" as const, 256, 256],
		["low" as const, 256, 16000],
		[undefined, 256, 16000],
	])("effort=%s, base=%i -> %i", (effort, base, expected) => {
		expect(
			outputBudget({ provider: "anthropic", model: "x", effort }, base),
		).toBe(expected);
	});
});

describe("cheapSelection", () => {
	it("maps anthropic to haiku at low effort", () => {
		expect(
			cheapSelection({ provider: "anthropic", model: "x", effort: "high" }),
		).toEqual({
			provider: "anthropic",
			model: "claude-haiku-5-5",
			effort: "low",
		});
	});

	it("maps openai to luna at low effort", () => {
		expect(cheapSelection({ provider: "openai", model: "x" })).toEqual({
			provider: "openai",
			model: "gpt-6-luna",
			effort: "low",
		});
	});

	it("keeps google on its own model at low effort", () => {
		expect(
			cheapSelection({
				provider: "google",
				model: "gemini-3.8-flash",
				effort: "high",
			}),
		).toEqual({
			provider: "google",
			model: "gemini-3.8-flash",
			effort: "low",
		});
	});
});

describe("resolveSkillModel", () => {
	const withReviewer = (patch: Record<string, unknown>): Config => {
		const tree = getConfigTree();
		const claude = tree.reviewers.claude as Config["reviewers"][string];
		return {
			...tree,
			reviewers: { ...tree.reviewers, claude: { ...claude, ...patch } },
		} as Config;
	};

	it("falls back to the tier model", () => {
		const config = withReviewer({});
		expect(
			resolveSkillModel(config, "claude", "code-reviewer", "normal"),
		).toEqual(resolveFinderModel(config, "claude", "normal"));
	});

	it("uses the skill model over the tier model", () => {
		const config = withReviewer({
			skills: {
				"code-reviewer": { model: "anthropic/claude-haiku-5-5", effort: "low" },
			},
		});
		expect(
			resolveSkillModel(config, "claude", "code-reviewer", "deep"),
		).toEqual({
			provider: "anthropic",
			model: "claude-haiku-5-5",
			effort: "low",
		});
		expect(
			resolveSkillModel(config, "claude", "security-sast", "deep"),
		).toEqual(resolveFinderModel(config, "claude", "deep"));
	});

	it("uses the skill tier model over the skill model", () => {
		const config = withReviewer({
			skills: {
				"code-reviewer": {
					model: "anthropic/claude-haiku-5-5",
					deep: { model: "anthropic/claude-opus-5-5", effort: "high" },
				},
			},
		});
		expect(
			resolveSkillModel(config, "claude", "code-reviewer", "deep"),
		).toEqual({
			provider: "anthropic",
			model: "claude-opus-5-5",
			effort: "high",
		});
		expect(
			resolveSkillModel(config, "claude", "code-reviewer", "normal"),
		).toEqual({
			provider: "anthropic",
			model: "claude-haiku-5-5",
		});
	});

	it("matches routeModel for every skill and tier of the real YAML", () => {
		const config = getConfigTree();
		const tiers = ["trivial", "normal", "complex", "deep"] as const;
		const contexts: Record<(typeof tiers)[number], RouterContext> = {
			trivial: {
				...base,
				filePaths: ["README.md"],
				additions: 1,
				deletions: 0,
			},
			normal: base,
			complex: { ...base, filePaths: ["src/auth/login.ts"] },
			deep: { ...base, labels: [config.routing.deepLabel] },
		};
		for (const [reviewerId, legacy] of [
			["claude", "anthropic"],
			["codex", "openai"],
		] as const) {
			for (const tier of tiers) {
				const routed = routeModel(contexts[tier], legacy);
				expect(routeReviewerModel(contexts[tier], reviewerId).tier).toBe(tier);
				for (const skill of SKILL_NAMES) {
					expect(resolveSkillModel(config, reviewerId, skill, tier)).toEqual({
						provider: routed.provider,
						model: routed.model,
						effort: routed.effort,
					});
				}
			}
		}
	});
});

describe("shouldRunOnTier", () => {
	const config = getConfigTree();
	const withRunOn = (runOn: string[] | undefined): Config =>
		({
			...config,
			reviewers: {
				...config.reviewers,
				claude: { ...config.reviewers.claude, runOn },
			},
		}) as Config;

	it("runs on every tier when runOn is absent", () => {
		for (const tier of ["trivial", "normal", "complex", "deep"] as const) {
			expect(shouldRunOnTier(withRunOn(undefined), "claude", tier)).toBe(true);
		}
	});

	it("runs only on listed tiers, without classifying the PR", () => {
		const cfg = withRunOn(["complex", "deep"]);
		expect(shouldRunOnTier(cfg, "claude", "complex")).toBe(true);
		expect(shouldRunOnTier(cfg, "claude", "normal")).toBe(false);
		expect(shouldRunOnTier.length).toBe(3);
	});
});
