import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../src/config/load.js";
import handler, { sanitizeConfigError } from "./debug.js";

const SECRET = "cron-secret-value";

beforeEach(() => {
	vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
	resetConfigForTests();
	vi.unstubAllEnvs();
});

function call(authorization: string | null = `Bearer ${SECRET}`) {
	let body: Record<string, unknown> = {};
	const res = {
		status: () => res,
		json: (payload: Record<string, unknown>) => {
			body = payload;
			return res;
		},
	};
	handler(
		{ headers: { authorization: authorization ?? undefined } } as VercelRequest,
		res as unknown as VercelResponse,
	);
	return body;
}

describe("GET /api/debug", () => {
	it("reports config leaves with sources and keeps the has* fields", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
		vi.stubEnv("OPENAI_API_KEY", "");
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

	it("redacts every set cli and infra value but not other leaves", () => {
		vi.stubEnv("AI_REVIEW_CLI__GATE_DIR", "/home/joe/secret-gate");
		vi.stubEnv("PUBLIC_URL", "https://internal.example.com");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const body = call();
		expect(body.config).toContainEqual(
			expect.objectContaining({ path: "cli.gateDir", value: "[set]" }),
		);
		expect(body.config).toContainEqual(
			expect.objectContaining({ path: "infra.publicUrl", value: "[set]" }),
		);
		expect(body.config).toContainEqual(
			expect.objectContaining({ path: "review.command", value: "/ai-review" }),
		);
		const text = JSON.stringify(body);
		expect(text).not.toContain("secret-gate");
		expect(text).not.toContain("internal.example.com");
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

	it("logs the sanitized config error server-side when config loading throws", () => {
		vi.stubEnv("AI_REVIEW_TYPO", "1");
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const body = call();
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const logged = String(errorSpy.mock.calls[0]?.[0]);
		expect(logged).toContain(String(body.configError));
		expect(logged).not.toContain("sk-ant-secret");
	});
});

describe("GET /api/debug authorization", () => {
	const mainShape = [
		"hasAnthropicKey",
		"hasAppId",
		"hasOpenAIAppId",
		"hasOpenAIKey",
		"hasOpenAIPrivateKey",
		"hasOpenAIWebhookSecret",
		"hasPrivateKey",
		"hasWebhookSecret",
		"reviewCommand",
		"reviewEnabled",
	];

	function expectMainShape(body: Record<string, unknown>) {
		expect(Object.keys(body).sort()).toEqual(mainShape);
		expect(body.reviewEnabled).toBe(true);
		expect(body.reviewCommand).toBe("/ai-review");
	}

	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("gives a request with no header only the main-shaped response", () => {
		expectMainShape(call(null));
	});

	it("gives a wrong secret only the main-shaped response", () => {
		expectMainShape(call("Bearer wrong"));
		expectMainShape(call(`Bearer ${SECRET}x`));
	});

	it("gives everyone only the main-shaped response when CRON_SECRET is unset or empty", () => {
		for (const value of [undefined, ""]) {
			vi.stubEnv("CRON_SECRET", value as string);
			if (value === undefined) delete process.env.CRON_SECRET;
			expectMainShape(call("Bearer "));
			expectMainShape(call("Bearer"));
		}
	});

	it("returns the full report for the right secret", () => {
		const body = call();
		expect(body.config).toBeDefined();
		expect(body.warnings).toBeDefined();
	});

	it("returns configError only when authorized", () => {
		vi.stubEnv("AI_REVIEW_TYPO", "1");
		const denied = call("Bearer wrong");
		expect(denied.configError).toBeUndefined();
		expect(denied.config).toBeUndefined();
		expect(denied.warnings).toBeUndefined();
		expect(denied.hasAnthropicKey).toBeDefined();
		expect(String(call().configError)).toContain("AI_REVIEW_TYPO");
	});
});

describe("sanitizeConfigError", () => {
	it("redacts a quoted env value but keeps the variable name and expected type", () => {
		const message = sanitizeConfigError(
			new Error(
				'AI_REVIEW_REVIEW__DELAY_SECONDS: expected number, got "sk-live-secret"',
			),
		);
		expect(message).not.toContain("sk-live-secret");
		expect(message).toContain("AI_REVIEW_REVIEW__DELAY_SECONDS");
		expect(message).toContain("expected number");
		expect(message).toContain('got "[redacted]"');
	});

	it("redacts a value that contains an inner or escaped quote", () => {
		for (const value of ['x"TOP-SECRET', 'x\\"TOP-SECRET']) {
			const message = sanitizeConfigError(
				new Error(
					`AI_REVIEW_REVIEW__DELAY_SECONDS: expected number, got "${value}"`,
				),
			);
			expect(message).not.toContain("TOP-SECRET");
			expect(message).toContain("AI_REVIEW_REVIEW__DELAY_SECONDS");
			expect(message).toContain("expected number");
		}
	});

	it("redacts through line terminators after the marker", () => {
		for (const terminator of ["\r", "\u2028", "\u2029", "\n"]) {
			const message = sanitizeConfigError(
				new Error(
					`AI_REVIEW_X: expected number, got "x${terminator}TOP-SECRET`,
				),
			);
			expect(message).not.toContain("TOP-SECRET");
			expect(message).toContain("AI_REVIEW_X");
		}
	});

	it("truncates at a carriage return with no got/value marker", () => {
		const message = sanitizeConfigError(
			new Error("Invalid YAML near line 2\rTOP-SECRET-PROMPT"),
		);
		expect(message).not.toContain("TOP-SECRET-PROMPT");
	});

	it("truncates at a U+2028 line separator with no got/value marker", () => {
		const message = sanitizeConfigError(
			new Error("Invalid YAML near line 2 TOP-SECRET-PROMPT"),
		);
		expect(message).not.toContain("TOP-SECRET-PROMPT");
	});

	it("redacts a value form through line terminators", () => {
		const message = sanitizeConfigError(
			new Error('bad value "x\u2028TOP-SECRET" for AI_REVIEW_X'),
		);
		expect(message).not.toContain("TOP-SECRET");
	});

	it("redacts a quoted segment after the word value", () => {
		const message = sanitizeConfigError(
			new Error('bad value "hunter2" for AI_REVIEW_X'),
		);
		expect(message).not.toContain("hunter2");
	});

	it("redacts a value after the word value that contains an inner or escaped quote", () => {
		for (const value of ['x"TOP-SECRET', 'x\\"TOP-SECRET']) {
			const message = sanitizeConfigError(
				new Error(`AI_REVIEW_X: bad value "${value}" for config`),
			);
			expect(message).not.toContain("TOP-SECRET");
			expect(message).toContain("AI_REVIEW_X");
		}
	});

	it("caps the message at 300 characters", () => {
		expect(sanitizeConfigError(new Error("x".repeat(500)))).toHaveLength(300);
	});

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

	it("reduces an absolute path following '=' to its basename", () => {
		const message = sanitizeConfigError(
			new Error("failed to read file=/var/task/x.yaml"),
		);
		expect(message).not.toContain("/var/task");
		expect(message).toContain("file=x.yaml");
	});

	it("reduces an absolute path following ':' to its basename", () => {
		const message = sanitizeConfigError(
			new Error("failed to read file:/var/task/x.yaml"),
		);
		expect(message).not.toContain("/var/task");
		expect(message).toContain("file:x.yaml");
	});
});
