import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "./config/load.js";
import { getConfig, getOpenAIAppConfig, parseAgentBudgetMs } from "./config.js";

const PKCS8_KEY =
	"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7\n-----END PRIVATE KEY-----";

const PKCS1_KEY =
	"-----BEGIN RSA PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7\n-----END RSA PRIVATE KEY-----";

function setRequiredEnv(overrides: Record<string, string> = {}) {
	process.env.GITHUB_APP_ID = "123";
	process.env.GITHUB_APP_PRIVATE_KEY = PKCS8_KEY;
	process.env.GITHUB_WEBHOOK_SECRET = "secret";
	process.env.ANTHROPIC_API_KEY = "sk-ant-test";
	for (const [k, v] of Object.entries(overrides)) {
		process.env[k] = v;
	}
}

function setOpenAIEnv(overrides: Record<string, string> = {}) {
	process.env.OPENAI_APP_ID = "456";
	process.env.OPENAI_APP_PRIVATE_KEY = PKCS8_KEY;
	process.env.OPENAI_APP_WEBHOOK_SECRET = "secret";
	for (const [k, v] of Object.entries(overrides)) {
		process.env[k] = v;
	}
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
	for (const key of [
		"GITHUB_APP_ID",
		"GITHUB_APP_PRIVATE_KEY",
		"GITHUB_WEBHOOK_SECRET",
		"ANTHROPIC_API_KEY",
		"REVIEW_ENABLED",
		"FEEDBACK_ENABLED",
		"OPENAI_APP_ID",
		"OPENAI_APP_PRIVATE_KEY",
		"OPENAI_APP_WEBHOOK_SECRET",
		"REVIEW_COMMENT_PREFIX",
		"OPENAI_REVIEW_COMMENT_PREFIX",
		"REVIEW_DELAY_SECONDS",
		"IMPROVE_CARRIER_ENABLED",
		"REVIEW_RESYNC_DELAY_SECONDS",
		"AGENT_CONCURRENCY",
		"REVIEW_TIER2_ENABLED",
		"REVIEW_COMMAND",
		"REVIEW_DIFF_BUDGET_CHARS",
		"IMPROVE_ENABLED",
		"QSTASH_TOKEN",
		"QSTASH_CURRENT_SIGNING_KEY",
		"QSTASH_NEXT_SIGNING_KEY",
		"QSTASH_URL",
		"PUBLIC_URL",
	]) {
		delete process.env[key];
	}
});

describe("review delay parsing", () => {
	it("defaults to no delay for initial and resync when unset", () => {
		setRequiredEnv();
		setOpenAIEnv();
		const config = getConfig();
		expect(config.reviewDelayMs).toBe(0);
		expect(config.reviewResyncDelayMs).toBe(0);
		expect(getOpenAIAppConfig().reviewDelayMs).toBe(0);
		expect(getOpenAIAppConfig().reviewResyncDelayMs).toBe(0);
	});

	it("parses valid numeric seconds into milliseconds", () => {
		setRequiredEnv({
			REVIEW_DELAY_SECONDS: "120",
			REVIEW_RESYNC_DELAY_SECONDS: "60",
		});
		const config = getConfig();
		expect(config.reviewDelayMs).toBe(120_000);
		expect(config.reviewResyncDelayMs).toBe(60_000);
	});

	it("keeps an env override of 30s as 30s", () => {
		setRequiredEnv({
			REVIEW_DELAY_SECONDS: "30",
			REVIEW_RESYNC_DELAY_SECONDS: "30",
		});
		expect(getConfig().reviewDelayMs).toBe(30_000);
		expect(getConfig().reviewResyncDelayMs).toBe(30_000);
		setOpenAIEnv();
		expect(getOpenAIAppConfig().reviewDelayMs).toBe(30_000);
		expect(getOpenAIAppConfig().reviewResyncDelayMs).toBe(30_000);
	});

	it("accepts 0 as an explicit no-delay value", () => {
		setRequiredEnv({ REVIEW_DELAY_SECONDS: "0" });
		expect(getConfig().reviewDelayMs).toBe(0);
	});

	it("treats blank values as unset", () => {
		for (const blank of ["", "   "]) {
			setRequiredEnv({ REVIEW_DELAY_SECONDS: blank });
			expect(getConfig().reviewDelayMs).toBe(0);
			resetConfigForTests();
		}
	});

	it("now throws on non-numeric or negative values instead of falling back", () => {
		for (const bad of ["abc", "-30"]) {
			resetConfigForTests();
			setRequiredEnv({ REVIEW_DELAY_SECONDS: bad });
			expect(() => getConfig()).toThrow(
				/review\.delaySeconds|REVIEW_DELAY_SECONDS/,
			);
		}
	});
});

describe("IMPROVE_CARRIER_ENABLED", () => {
	it("is off by default for both providers", () => {
		setRequiredEnv();
		setOpenAIEnv();
		expect(getConfig().improveCarrierEnabled).toBe(false);
		expect(getOpenAIAppConfig().improveCarrierEnabled).toBe(false);
	});

	it('is on only when the value is exactly "true"', () => {
		setRequiredEnv({ IMPROVE_CARRIER_ENABLED: "true" });
		setOpenAIEnv();
		expect(getConfig().improveCarrierEnabled).toBe(true);
		expect(getOpenAIAppConfig().improveCarrierEnabled).toBe(true);
		for (const off of ["false", "", "  "]) {
			resetConfigForTests();
			process.env.IMPROVE_CARRIER_ENABLED = off;
			expect(getConfig().improveCarrierEnabled).toBe(false);
		}
	});

	it("now throws on a malformed boolean instead of reading it as off", () => {
		for (const bad of ["1", "yes"]) {
			resetConfigForTests();
			setRequiredEnv({ IMPROVE_CARRIER_ENABLED: bad });
			expect(() => getConfig()).toThrow(/IMPROVE_CARRIER_ENABLED/);
		}
	});
});

describe("getConfig", () => {
	describe("REVIEW_ENABLED", () => {
		it("defaults to true when env var is unset", () => {
			setRequiredEnv();
			expect(getConfig().reviewEnabled).toBe(true);
		});

		it("is false when REVIEW_ENABLED=false", () => {
			setRequiredEnv({ REVIEW_ENABLED: "false" });
			expect(getConfig().reviewEnabled).toBe(false);
		});

		it("is true when REVIEW_ENABLED=true", () => {
			setRequiredEnv({ REVIEW_ENABLED: "true" });
			expect(getConfig().reviewEnabled).toBe(true);
		});
	});

	describe("validatePrivateKey", () => {
		it("accepts a PKCS#8 key", () => {
			setRequiredEnv({ GITHUB_APP_PRIVATE_KEY: PKCS8_KEY });
			expect(() => getConfig()).not.toThrow();
		});

		it("throws on a PKCS#1 key with a clear message", () => {
			setRequiredEnv({ GITHUB_APP_PRIVATE_KEY: PKCS1_KEY });
			expect(() => getConfig()).toThrow(/PKCS#1/);
			expect(() => getConfig()).toThrow(/PKCS#8/);
		});

		it("normalizes escaped newlines in the key", () => {
			const escaped = PKCS8_KEY.replace(/\n/g, "\\n");
			setRequiredEnv({ GITHUB_APP_PRIVATE_KEY: escaped });
			expect(getConfig().privateKey).toContain("\n");
		});
	});

	describe("requireWebhookSecret option", () => {
		it("throws on a missing webhook secret by default (webhook-serving behavior unchanged)", () => {
			setRequiredEnv();
			delete process.env.GITHUB_WEBHOOK_SECRET;
			expect(() => getConfig()).toThrow(/GITHUB_WEBHOOK_SECRET/);
		});

		it("does not throw on a missing webhook secret when requireWebhookSecret is false", () => {
			setRequiredEnv();
			delete process.env.GITHUB_WEBHOOK_SECRET;
			expect(() => getConfig({ requireWebhookSecret: false })).not.toThrow();
		});

		it("webhookSecret is an empty string when unset and not required", () => {
			setRequiredEnv();
			delete process.env.GITHUB_WEBHOOK_SECRET;
			expect(getConfig({ requireWebhookSecret: false }).webhookSecret).toBe("");
		});

		it("still returns the real secret when present, even with requireWebhookSecret: false", () => {
			setRequiredEnv({ GITHUB_WEBHOOK_SECRET: "real-secret" });
			expect(getConfig({ requireWebhookSecret: false }).webhookSecret).toBe(
				"real-secret",
			);
		});
	});
});

describe("getOpenAIAppConfig requireWebhookSecret option", () => {
	it("throws on a missing webhook secret by default", () => {
		setOpenAIEnv();
		delete process.env.OPENAI_APP_WEBHOOK_SECRET;
		expect(() => getOpenAIAppConfig()).toThrow(/OPENAI_APP_WEBHOOK_SECRET/);
	});

	it("does not throw and returns an empty string when requireWebhookSecret is false", () => {
		setOpenAIEnv();
		delete process.env.OPENAI_APP_WEBHOOK_SECRET;
		expect(
			getOpenAIAppConfig({ requireWebhookSecret: false }).webhookSecret,
		).toBe("");
	});
});

describe("feedbackEnabled", () => {
	it("defaults to false and is true only when FEEDBACK_ENABLED=true", () => {
		setRequiredEnv();
		delete process.env.FEEDBACK_ENABLED;
		expect(getConfig().feedbackEnabled).toBe(false);
		resetConfigForTests();
		process.env.FEEDBACK_ENABLED = "true";
		expect(getConfig().feedbackEnabled).toBe(true);
		resetConfigForTests();
		process.env.FEEDBACK_ENABLED = "1";
		expect(() => getConfig()).toThrow(/FEEDBACK_ENABLED/);
		delete process.env.FEEDBACK_ENABLED;
	});
});

describe("getOpenAIAppConfig reviewCommentPrefix", () => {
	it("defaults to codex-review-bot", () => {
		setOpenAIEnv();
		expect(getOpenAIAppConfig().reviewCommentPrefix).toBe("codex-review-bot");
	});

	it("falls back to REVIEW_COMMENT_PREFIX when no OpenAI-specific override", () => {
		setOpenAIEnv({ REVIEW_COMMENT_PREFIX: "shared-prefix" });
		expect(getOpenAIAppConfig().reviewCommentPrefix).toBe("shared-prefix");
	});

	it("OPENAI_REVIEW_COMMENT_PREFIX overrides REVIEW_COMMENT_PREFIX", () => {
		setOpenAIEnv({
			REVIEW_COMMENT_PREFIX: "shared-prefix",
			OPENAI_REVIEW_COMMENT_PREFIX: "codex-only",
		});
		expect(getOpenAIAppConfig().reviewCommentPrefix).toBe("codex-only");
	});

	it("treats a blank OPENAI_REVIEW_COMMENT_PREFIX as unset → falls back to REVIEW_COMMENT_PREFIX", () => {
		setOpenAIEnv({
			OPENAI_REVIEW_COMMENT_PREFIX: "",
			REVIEW_COMMENT_PREFIX: "shared-prefix",
		});
		expect(getOpenAIAppConfig().reviewCommentPrefix).toBe("shared-prefix");
	});

	it("treats blank OpenAI + shared prefixes as unset → falls back to codex-review-bot", () => {
		setOpenAIEnv({
			OPENAI_REVIEW_COMMENT_PREFIX: "   ",
			REVIEW_COMMENT_PREFIX: "",
		});
		expect(getOpenAIAppConfig().reviewCommentPrefix).toBe("codex-review-bot");
	});
});

describe("agentConcurrency", () => {
	it("defaults to 4 and parses AGENT_CONCURRENCY", () => {
		setRequiredEnv();
		delete process.env.AGENT_CONCURRENCY;
		expect(getConfig().agentConcurrency).toBe(4);
		resetConfigForTests();
		process.env.AGENT_CONCURRENCY = "3";
		expect(getConfig().agentConcurrency).toBe(3);
		for (const bad of ["abc", "0"]) {
			resetConfigForTests();
			process.env.AGENT_CONCURRENCY = bad;
			expect(() => getConfig()).toThrow(
				/AGENT_CONCURRENCY|review\.agentConcurrency/,
			);
		}
		delete process.env.AGENT_CONCURRENCY;
	});
});

describe("tier2Enabled default (PR2 flips it ON)", () => {
	it("defaults to TRUE now that QStash frees the budget", () => {
		setRequiredEnv();
		delete process.env.REVIEW_TIER2_ENABLED;
		expect(getConfig().tier2Enabled).toBe(true);
	});

	it("is false only when explicitly REVIEW_TIER2_ENABLED=false", () => {
		setRequiredEnv({ REVIEW_TIER2_ENABLED: "false" });
		expect(getConfig().tier2Enabled).toBe(false);
	});
});

describe("qstash + publicUrl config", () => {
	it("parses QStash keys and PUBLIC_URL", () => {
		setRequiredEnv({
			QSTASH_TOKEN: "qs-tok",
			QSTASH_CURRENT_SIGNING_KEY: "cur",
			QSTASH_NEXT_SIGNING_KEY: "nxt",
			QSTASH_URL: "https://qstash-us-east-1.upstash.io",
			PUBLIC_URL: "https://example.test",
		});
		const c = getConfig();
		expect(c.qstashToken).toBe("qs-tok");
		expect(c.qstashCurrentSigningKey).toBe("cur");
		expect(c.qstashNextSigningKey).toBe("nxt");
		expect(c.qstashUrl).toBe("https://qstash-us-east-1.upstash.io");
		expect(c.publicUrl).toBe("https://example.test");
	});

	it("leaves QStash fields undefined when unset (graceful fallback)", () => {
		setRequiredEnv();
		expect(getConfig().qstashToken).toBeUndefined();
	});
});

describe("parseAgentBudgetMs", () => {
	// Captured per test, not once at module load: a value snapshotted at
	// collection time restores whatever was set then, not what this test found.
	let original: string | undefined;
	beforeEach(() => {
		original = process.env.REVIEW_AGENT_BUDGET_SECONDS;
	});
	afterEach(() => {
		if (original === undefined) delete process.env.REVIEW_AGENT_BUDGET_SECONDS;
		else process.env.REVIEW_AGENT_BUDGET_SECONDS = original;
	});

	it("defaults to 210s, leaving room under the 300s Hobby cap", () => {
		delete process.env.REVIEW_AGENT_BUDGET_SECONDS;
		expect(parseAgentBudgetMs()).toBe(210_000);
	});

	// Flooring seconds first turned these into a 0ms budget, which skips every
	// agent and posts a review with no findings rather than failing loudly.
	it.each([
		["0.9", 900],
		["0.5", 500],
		["0.001", 1],
	])("keeps a sub-second budget of %s rather than collapsing it to zero", (raw, ms) => {
		process.env.REVIEW_AGENT_BUDGET_SECONDS = raw;
		expect(parseAgentBudgetMs()).toBe(ms);
	});

	// Never zero: a budget of 0 is indistinguishable from "skip everything".
	it("floors at 1ms for a positive value below one millisecond", () => {
		process.env.REVIEW_AGENT_BUDGET_SECONDS = "0.0000001";
		expect(parseAgentBudgetMs()).toBe(1);
	});

	it.each(["0", "-5", "abc"])("a malformed value %s now throws", (raw) => {
		process.env.REVIEW_AGENT_BUDGET_SECONDS = raw;
		expect(() => parseAgentBudgetMs()).toThrow(
			/REVIEW_AGENT_BUDGET_SECONDS|review\.agentBudgetSeconds/,
		);
	});

	it.each([
		"",
		"   ",
	])("a blank value %j is unset and gives the default", (raw) => {
		process.env.REVIEW_AGENT_BUDGET_SECONDS = raw;
		expect(parseAgentBudgetMs()).toBe(210_000);
	});
});

describe("diffBudgetChars", () => {
	it.each([
		[undefined, 200_000],
		["50000", 50_000],
		["", 200_000],
	])("REVIEW_DIFF_BUDGET_CHARS=%s gives %i", (raw, expected) => {
		setRequiredEnv();
		if (raw === undefined) delete process.env.REVIEW_DIFF_BUDGET_CHARS;
		else process.env.REVIEW_DIFF_BUDGET_CHARS = raw;
		expect(getConfig().diffBudgetChars).toBe(expected);
	});

	it.each(["abc", "0", "-5", "1.5"])("%s now throws", (raw) => {
		setRequiredEnv({ REVIEW_DIFF_BUDGET_CHARS: raw });
		expect(() => getConfig()).toThrow(
			/REVIEW_DIFF_BUDGET_CHARS|review\.diffBudgetChars/,
		);
	});
});

describe("config tree wiring", () => {
	it("getConfig reproduces the legacy defaults with an empty env", () => {
		setRequiredEnv();
		expect(getConfig()).toEqual({
			appId: "123",
			privateKey: PKCS8_KEY,
			webhookSecret: "secret",
			reviewEnabled: true,
			reviewDelayMs: 0,
			reviewResyncDelayMs: 0,
			reviewCommentPrefix: "ai-review-bot",
			reviewCommand: "/ai-review",
			provider: "anthropic",
			feedbackEnabled: false,
			improveEnabled: false,
			improveCarrierEnabled: false,
			agentConcurrency: 4,
			agentBudgetMs: 210_000,
			diffBudgetChars: 200_000,
			tier2Enabled: true,
			qstashToken: undefined,
			qstashCurrentSigningKey: undefined,
			qstashNextSigningKey: undefined,
			qstashUrl: undefined,
			publicUrl: undefined,
		});
	});

	it("AGENT_CONCURRENCY=2 sets concurrency through the alias and warns once", () => {
		setRequiredEnv({ AGENT_CONCURRENCY: "2" });
		expect(getConfig().agentConcurrency).toBe(2);
		expect(getConfig().agentConcurrency).toBe(2);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("AGENT_CONCURRENCY is deprecated"),
		);
	});

	it("getOpenAIAppConfig keeps provider openai and its own prefix default", () => {
		setOpenAIEnv();
		const c = getOpenAIAppConfig();
		expect(c.provider).toBe("openai");
		expect(c.reviewCommentPrefix).toBe("codex-review-bot");
	});
});
