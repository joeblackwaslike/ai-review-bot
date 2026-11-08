import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLiveOverrides, getEffectiveConfig } from "./config/edge.js";
import { getConfigTree, resetConfigForTests } from "./config/load.js";
import {
	getLiveReviewerAppConfig,
	getReviewerAppConfig,
	listReviewerIds,
	logReviewerReadiness,
	missingProviderKeys,
	ReviewerNotReadyError,
	reviewerAuthProvider,
	reviewerProviders,
	reviewerReadiness,
	UnknownReviewerError,
} from "./reviewers.js";

vi.mock("./config/edge.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./config/edge.js")>()),
	getEffectiveConfig: vi.fn(),
}));

const KEY =
	"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7\n-----END PRIVATE KEY-----";

const SNAPSHOT = { ...process.env };
let warn: ReturnType<typeof vi.spyOn>;

function claudeEnv(extra: Record<string, string> = {}) {
	Object.assign(process.env, {
		GITHUB_APP_ID: "123",
		GITHUB_APP_PRIVATE_KEY: KEY,
		GITHUB_WEBHOOK_SECRET: "whsec",
		ANTHROPIC_API_KEY: "sk-ant",
		...extra,
	});
}

function geminiEnv(extra: Record<string, string> = {}) {
	Object.assign(process.env, {
		AI_REVIEW_REVIEWERS__GEMINI__ENABLED: "true",
		AI_REVIEW_REVIEWERS__GEMINI__APP_ID: "789",
		AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY: KEY,
		AI_REVIEW_REVIEWERS__GEMINI__WEBHOOK_SECRET: "gem-secret",
		GOOGLE_GENERATIVE_AI_API_KEY: "g-key",
		...extra,
	});
}

beforeEach(() => {
	vi.mocked(getEffectiveConfig).mockImplementation(async () => ({
		config: getConfigTree(),
		applied: [],
		ignored: [],
	}));
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
	for (const key of Object.keys(process.env)) {
		if (!(key in SNAPSHOT)) delete process.env[key];
	}
	Object.assign(process.env, SNAPSHOT);
	resetConfigForTests();
});

describe("getReviewerAppConfig", () => {
	it.each([
		"nope",
		"__proto__",
		"constructor",
	])("unknown id %s throws UnknownReviewerError", (id) => {
		claudeEnv();
		expect(() => getReviewerAppConfig(id)).toThrow(UnknownReviewerError);
		expect(() => reviewerReadiness(id, "hosted")).toThrow(UnknownReviewerError);
	});

	it("returns concurrency and prefix from YAML for gemini", () => {
		geminiEnv({ AI_REVIEW_REVIEWERS__GEMINI__CONCURRENCY: "2" });
		const c = getReviewerAppConfig("gemini");
		expect(c.agentConcurrency).toBe(2);
		expect(c.reviewCommentPrefix).toBe("gemini-review-bot");
		expect(c.reviewer).toBe("gemini");
		expect(c.appSlug).toBe("geminireviewbot");
		expect(c.webhookSecret).toBe("gem-secret");
	});

	it("names the legacy variable when a claude secret is missing", () => {
		claudeEnv();
		delete process.env.GITHUB_APP_PRIVATE_KEY;
		expect(() => getReviewerAppConfig("claude")).toThrow(
			"Missing required environment variable: GITHUB_APP_PRIVATE_KEY",
		);
	});

	it("names the derived variable when a gemini secret is missing", () => {
		geminiEnv();
		delete process.env.AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY;
		expect(() => getReviewerAppConfig("gemini")).toThrow(
			"Missing required environment variable: AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY",
		);
	});

	it("falls back to the shared github.webhookSecret", () => {
		geminiEnv({ AI_REVIEW_GITHUB__WEBHOOK_SECRET: "shared" });
		delete process.env.AI_REVIEW_REVIEWERS__GEMINI__WEBHOOK_SECRET;
		expect(getReviewerAppConfig("gemini").webhookSecret).toBe("shared");
	});

	it("never puts a secret value in an error", () => {
		claudeEnv({ GITHUB_APP_PRIVATE_KEY: "BEGIN RSA PRIVATE KEY topsecret" });
		let message = "";
		try {
			getReviewerAppConfig("claude");
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("PKCS#1");
		expect(message).not.toContain("topsecret");
	});
});

describe("missingProviderKeys", () => {
	it("names the google key for gemini in cli mode without asking for app credentials", () => {
		expect(missingProviderKeys("gemini", "cli", {})).toEqual([
			"GOOGLE_GENERATIVE_AI_API_KEY",
		]);
		expect(
			missingProviderKeys("gemini", "cli", {
				GOOGLE_GENERATIVE_AI_API_KEY: "k",
			}),
		).toEqual([]);
		expect(missingProviderKeys("claude", "cli", {})).toEqual([]);
	});
});

describe("reviewerReadiness", () => {
	it("a disabled reviewer with credentials is not ready", () => {
		geminiEnv({ AI_REVIEW_REVIEWERS__GEMINI__ENABLED: "false" });
		const r = reviewerReadiness("gemini", "hosted");
		expect(r.ready).toBe(false);
		expect(r.missing).toEqual(["reviewers.gemini.enabled"]);
	});

	it("missing only the webhook secret lists exactly that for hosted, ready for cli", () => {
		geminiEnv();
		delete process.env.AI_REVIEW_REVIEWERS__GEMINI__WEBHOOK_SECRET;
		expect(reviewerReadiness("gemini", "hosted")).toEqual({
			ready: false,
			missing: ["AI_REVIEW_REVIEWERS__GEMINI__WEBHOOK_SECRET"],
		});
		expect(reviewerReadiness("gemini", "cli")).toEqual({
			ready: true,
			missing: [],
		});
	});

	it("shared github.webhookSecret satisfies a reviewer with no own secret", () => {
		geminiEnv({ AI_REVIEW_GITHUB__WEBHOOK_SECRET: "shared" });
		delete process.env.AI_REVIEW_REVIEWERS__GEMINI__WEBHOOK_SECRET;
		expect(reviewerReadiness("gemini", "hosted").ready).toBe(true);
	});

	it("a google tier needs the google key hosted and in cli, not the anthropic key in cli", () => {
		claudeEnv();
		geminiEnv();
		delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		const tree = getConfigTree();
		expect(reviewerProviders(tree, "gemini")).toContain("google");
		expect(reviewerReadiness("gemini", "hosted").missing).toEqual([
			"GOOGLE_GENERATIVE_AI_API_KEY",
		]);
		expect(reviewerReadiness("gemini", "cli").missing).toEqual([
			"GOOGLE_GENERATIVE_AI_API_KEY",
		]);
		expect(reviewerReadiness("claude", "cli").ready).toBe(true);
		expect(reviewerReadiness("claude", "hosted").missing).toEqual([
			"ANTHROPIC_API_KEY",
		]);
	});
});

describe("reviewer role providers", () => {
	function withRole(): ReturnType<typeof getConfigTree> {
		const tree = getConfigTree();
		const claude = tree.reviewers.claude as (typeof tree.reviewers)[string];
		return {
			...tree,
			reviewers: {
				...tree.reviewers,
				claude: {
					...claude,
					roles: { triage: { model: "google/gemini-3-flash" } },
				},
			},
		};
	}

	it("reviewerProviders includes providers used only by a role", () => {
		claudeEnv();
		const tree = withRole();
		expect(reviewerProviders(getConfigTree(), "claude")).not.toContain(
			"google",
		);
		expect(reviewerProviders(tree, "claude")).toContain("google");
	});

	it("a reviewer whose role provider has no key is not ready in hosted mode and names the missing key", () => {
		claudeEnv();
		delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
		process.env.AI_REVIEW_REVIEWERS__CLAUDE__ROLES__TRIAGE__MODEL =
			"google/gemini-3-flash";
		expect(reviewerReadiness("claude", "hosted")).toEqual({
			ready: false,
			missing: ["GOOGLE_GENERATIVE_AI_API_KEY"],
		});
	});
});

describe("top-level role providers", () => {
	it("a top-level triage role counts for every reviewer without its own entry", () => {
		claudeEnv();
		process.env.AI_REVIEW_ROLES__TRIAGE__MODEL = "openai/gpt-6-luna";
		resetConfigForTests();
		const tree = getConfigTree();
		expect(reviewerProviders(tree, "claude")).toContain("openai");
		expect(reviewerAuthProvider(tree, "claude")).toBeNull();
	});

	it("a reviewer's own role entry shadows the top-level one", () => {
		claudeEnv();
		process.env.AI_REVIEW_ROLES__TRIAGE__MODEL = "openai/gpt-6-luna";
		process.env.AI_REVIEW_REVIEWERS__CLAUDE__ROLES__TRIAGE__MODEL =
			"anthropic/claude-haiku-5-5";
		resetConfigForTests();
		expect(reviewerProviders(getConfigTree(), "claude")).not.toContain(
			"openai",
		);
	});

	it("qcJudge and classifier stay exempt", () => {
		claudeEnv();
		process.env.AI_REVIEW_ROLES__QC_JUDGE__MODEL = "openai/gpt-6-luna";
		process.env.AI_REVIEW_ROLES__CLASSIFIER__MODEL = "google/gemini-3-flash";
		resetConfigForTests();
		const providers = reviewerProviders(getConfigTree(), "claude");
		expect(providers).not.toContain("openai");
		expect(providers).not.toContain("google");
	});

	it("hosted readiness names the missing key of a top-level role provider", () => {
		claudeEnv();
		delete process.env.OPENAI_API_KEY;
		delete process.env.AI_REVIEW_PROVIDERS__OPENAI__API_KEY;
		process.env.AI_REVIEW_ROLES__TRIAGE__MODEL = "openai/gpt-6-luna";
		resetConfigForTests();
		const r = reviewerReadiness("claude", "hosted");
		expect(r.ready).toBe(false);
		expect(r.missing).toContain("OPENAI_API_KEY");
	});
});

describe("logReviewerReadiness", () => {
	it("logs one line per not-ready enabled reviewer, then nothing", () => {
		claudeEnv();
		delete process.env.GITHUB_WEBHOOK_SECRET;
		for (const id of ["CODEX", "GEMINI"]) {
			process.env[`AI_REVIEW_REVIEWERS__${id}__ENABLED`] = "false";
		}
		logReviewerReadiness();
		const lines = warn.mock.calls
			.map((c) => String(c[0]))
			.filter((l) => l.startsWith("reviewer "));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("reviewer claude disabled");
		expect(lines[0]).toContain("GITHUB_WEBHOOK_SECRET");
		warn.mockClear();
		logReviewerReadiness();
		expect(warn).not.toHaveBeenCalled();
	});

	it("zero enabled reviewers lists ids, logs nothing and does not throw", () => {
		for (const id of ["CLAUDE", "CODEX", "GEMINI"]) {
			process.env[`AI_REVIEW_REVIEWERS__${id}__ENABLED`] = "false";
		}
		expect(listReviewerIds()).toEqual(["claude", "codex", "gemini"]);
		expect(() => logReviewerReadiness()).not.toThrow();
		expect(
			warn.mock.calls.filter((c) => String(c[0]).startsWith("reviewer ")),
		).toHaveLength(0);
	});
});

describe("secret deprecation warnings", () => {
	it("warns once per cold start about deprecated aliases, never with a value", () => {
		claudeEnv({
			OPENAI_APP_PRIVATE_KEY: "topsecret",
			OPENAI_APP_WEBHOOK_SECRET: "topsecret",
		});
		getConfigTree();
		getConfigTree();
		const lines = warn.mock.calls.map((c) => String(c[0]));
		const text = lines.join("\n");
		expect(text).toContain("GITHUB_WEBHOOK_SECRET is deprecated");
		expect(text).toContain("OPENAI_APP_PRIVATE_KEY is deprecated");
		expect(text).not.toContain("topsecret");
		expect(
			lines.filter((l) => l.includes("OPENAI_APP_PRIVATE_KEY is deprecated")),
		).toHaveLength(1);
	});
});

it("ReviewerNotReadyError carries id and missing", () => {
	const e = new ReviewerNotReadyError("gemini", ["A", "B"]);
	expect(e.reviewerId).toBe("gemini");
	expect(e.missing).toEqual(["A", "B"]);
});

describe("getLiveReviewerAppConfig", () => {
	it("getLiveReviewerAppConfig reflects an Edge disable (reviewEnabled false)", async () => {
		claudeEnv();
		vi.mocked(getEffectiveConfig).mockImplementation(async () =>
			applyLiveOverrides(getConfigTree(), {
				AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: "false",
			}),
		);
		expect(getReviewerAppConfig("claude").reviewEnabled).toBe(true);
		expect((await getLiveReviewerAppConfig("claude")).reviewEnabled).toBe(
			false,
		);
	});

	it("takes budgets from the Edge-effective config", async () => {
		claudeEnv();
		vi.mocked(getEffectiveConfig).mockImplementation(async () =>
			applyLiveOverrides(getConfigTree(), {
				AI_REVIEW_REVIEW__AGENT_CONCURRENCY: 2,
				AI_REVIEW_REVIEW__AGENT_BUDGET_SECONDS: 99,
				AI_REVIEW_REVIEW__DIFF_BUDGET_CHARS: 12345,
			}),
		);
		const live = await getLiveReviewerAppConfig("claude");
		expect(live.agentConcurrency).toBe(2);
		expect(live.agentBudgetMs).toBe(99000);
		expect(live.diffBudgetChars).toBe(12345);
	});

	it("still throws UnknownReviewerError for an unknown id", async () => {
		claudeEnv();
		await expect(getLiveReviewerAppConfig("nope")).rejects.toThrow(
			UnknownReviewerError,
		);
	});
});
