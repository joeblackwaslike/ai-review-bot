import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../src/config/load.js";
import handler, { sanitizeConfigError } from "./debug.js";

afterEach(() => {
	resetConfigForTests();
	vi.unstubAllEnvs();
});

function call() {
	let body: Record<string, unknown> = {};
	const res = {
		status: () => res,
		json: (payload: Record<string, unknown>) => {
			body = payload;
			return res;
		},
	};
	handler({} as VercelRequest, res as unknown as VercelResponse);
	return body;
}

describe("GET /api/debug", () => {
	it("reports config leaves with sources and keeps the has* fields", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
		vi.stubEnv("REVIEW_COMMAND", "/x");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const body = call();
		expect(body.hasAnthropicKey).toBe(true);
		expect(body.hasOpenAIKey).toBe(false);
		expect(body.reviewCommand).toBe("/x");
		expect(body.reviewEnabled).toBe(true);
		expect(body.config).toContainEqual({
			path: "review.command",
			value: "/x",
			source: "alias",
		});
		expect(body.warnings).toEqual([
			"REVIEW_COMMAND is deprecated; use AI_REVIEW_REVIEW__COMMAND",
		]);
		expect(JSON.stringify(body)).not.toContain("sk-ant-secret");
	});

	it("redacts the custom prompt text", () => {
		vi.stubEnv("CUSTOM_REVIEW_PROMPT", "TOP-SECRET-PROMPT");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const body = call();
		expect(body.config).toContainEqual({
			path: "review.customPrompt",
			value: "[set]",
			source: "alias",
		});
		expect(JSON.stringify(body)).not.toContain("TOP-SECRET-PROMPT");
	});

	it("returns 200 with configError and the has* fields when config loading throws", () => {
		vi.stubEnv("AI_REVIEW_TYPO", "1");
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
		const body = call();
		expect(String(body.configError)).toContain("AI_REVIEW_TYPO");
		expect(body.hasAnthropicKey).toBe(true);
		expect(body.config).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("sk-ant-secret");
	});
});

describe("sanitizeConfigError", () => {
	it("drops YAML parser excerpts and absolute paths from the message", () => {
		const message = sanitizeConfigError(
			new Error(
				"Invalid YAML in /var/task/config/ai-review.yaml: Nested mappings are not allowed in compact mappings at line 2, column 17:\n\n  customPrompt: TOP-SECRET-PROMPT: bad\n                ^\n",
			),
		);
		expect(message).not.toContain("TOP-SECRET-PROMPT");
		expect(message).not.toContain("/var/task");
		expect(message).toContain("ai-review.yaml");
	});

	it("leaves provider/model ids intact", () => {
		const message = sanitizeConfigError(
			new Error('model "openai/gpt-missing" is not defined in models'),
		);
		expect(message).toBe('model "openai/gpt-missing" is not defined in models');
	});

	it("leaves a bare provider/model form hint intact", () => {
		const message = sanitizeConfigError(
			new Error("must look like provider/model"),
		);
		expect(message).toBe("must look like provider/model");
	});
});
