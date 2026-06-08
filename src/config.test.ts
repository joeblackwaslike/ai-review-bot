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
		"OPENAI_APP_ID",
		"OPENAI_APP_PRIVATE_KEY",
		"OPENAI_APP_WEBHOOK_SECRET",
		"REVIEW_COMMENT_PREFIX",
		"OPENAI_REVIEW_COMMENT_PREFIX",
	]) {
		delete process.env[key];
	}
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
});
