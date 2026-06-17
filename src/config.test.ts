import { afterEach, describe, expect, it } from "vitest";
import { getConfig, getOpenAIAppConfig } from "./config.js";

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

afterEach(() => {
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
		"REVIEW_RESYNC_DELAY_SECONDS",
		"AGENT_CONCURRENCY",
		"REVIEW_TIER2_ENABLED",
		"QSTASH_TOKEN",
		"QSTASH_CURRENT_SIGNING_KEY",
		"QSTASH_NEXT_SIGNING_KEY",
		"PUBLIC_URL",
	]) {
		delete process.env[key];
	}
});

describe("review delay parsing", () => {
	it("defaults to 540s initial / 300s resync when unset", () => {
		setRequiredEnv();
		const config = getConfig();
		expect(config.reviewDelayMs).toBe(540_000);
		expect(config.reviewResyncDelayMs).toBe(300_000);
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

	it("accepts 0 as an explicit no-delay value", () => {
		setRequiredEnv({ REVIEW_DELAY_SECONDS: "0" });
		expect(getConfig().reviewDelayMs).toBe(0);
	});

	it("falls back to the default for non-numeric, blank, or negative values", () => {
		for (const bad of ["abc", "", "   ", "-30"]) {
			setRequiredEnv({ REVIEW_DELAY_SECONDS: bad });
			// A bare Number() would yield NaN/negative → setTimeout fires
			// immediately and the dedup wait is silently lost.
			expect(getConfig().reviewDelayMs).toBe(540_000);
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
});

describe("feedbackEnabled", () => {
	it("defaults to false and is true only when FEEDBACK_ENABLED=true", () => {
		setRequiredEnv();
		delete process.env.FEEDBACK_ENABLED;
		expect(getConfig().feedbackEnabled).toBe(false);
		process.env.FEEDBACK_ENABLED = "true";
		expect(getConfig().feedbackEnabled).toBe(true);
		process.env.FEEDBACK_ENABLED = "1";
		expect(getConfig().feedbackEnabled).toBe(false); // only exact "true" enables
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
	it("defaults to 1 and parses AGENT_CONCURRENCY", () => {
		setRequiredEnv();
		delete process.env.AGENT_CONCURRENCY;
		expect(getConfig().agentConcurrency).toBe(1);
		process.env.AGENT_CONCURRENCY = "3";
		expect(getConfig().agentConcurrency).toBe(3);
		process.env.AGENT_CONCURRENCY = "abc";
		expect(getConfig().agentConcurrency).toBe(1);
		process.env.AGENT_CONCURRENCY = "0";
		expect(getConfig().agentConcurrency).toBe(1);
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
			PUBLIC_URL: "https://example.test",
		});
		const c = getConfig();
		expect(c.qstashToken).toBe("qs-tok");
		expect(c.qstashCurrentSigningKey).toBe("cur");
		expect(c.qstashNextSigningKey).toBe("nxt");
		expect(c.publicUrl).toBe("https://example.test");
	});

	it("leaves QStash fields undefined when unset (graceful fallback)", () => {
		setRequiredEnv();
		expect(getConfig().qstashToken).toBeUndefined();
	});
});
