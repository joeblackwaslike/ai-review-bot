import { createHmac } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "./config/load.js";
import { getReviewerGitHubApp } from "./github-app.js";
import { ReviewerNotReadyError, UnknownReviewerError } from "./reviewers.js";
import { createReviewerWebhookHandler } from "./webhook-handler.js";

const readRawBody = vi.hoisted(() => vi.fn());

vi.mock("@vercel/functions", () => ({
	waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock("./http.js", () => ({
	readRawBody: (...args: unknown[]) => readRawBody(...args),
}));

const KEY =
	"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7\n-----END PRIVATE KEY-----";
const PAYLOAD = '{"zen":"hello"}';
const SNAPSHOT = { ...process.env };

function claudeEnv(extra: Record<string, string> = {}) {
	Object.assign(process.env, {
		GITHUB_APP_ID: "123",
		GITHUB_APP_PRIVATE_KEY: KEY,
		GITHUB_WEBHOOK_SECRET: "claude-secret",
		ANTHROPIC_API_KEY: "sk-ant",
		...extra,
	});
}

function codexEnv(extra: Record<string, string> = {}) {
	Object.assign(process.env, {
		OPENAI_APP_ID: "456",
		OPENAI_APP_PRIVATE_KEY: KEY,
		OPENAI_APP_WEBHOOK_SECRET: "codex-secret",
		OPENAI_API_KEY: "sk-oai",
		...extra,
	});
}

function geminiEnv(extra: Record<string, string> = {}) {
	Object.assign(process.env, {
		AI_REVIEW_REVIEWERS__GEMINI__ENABLED: "true",
		AI_REVIEW_REVIEWERS__GEMINI__APP_ID: "789",
		AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY: KEY,
		GOOGLE_GENERATIVE_AI_API_KEY: "g-key",
		AI_REVIEW_GITHUB__WEBHOOK_SECRET: "shared-secret",
		...extra,
	});
}

function sign(secret: string, payload = PAYLOAD) {
	return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function stubRes() {
	const res = {
		statusCode: 0,
		body: undefined as unknown,
		headers: {} as Record<string, string>,
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(payload: unknown) {
			res.body = payload;
			return res;
		},
		setHeader(name: string, value: string) {
			res.headers[name] = value;
			return res;
		},
	};
	return res;
}

function stubReq(
	over: Partial<VercelRequest> = {},
	signature = sign("shared-secret"),
): VercelRequest {
	return {
		method: "POST",
		query: {},
		headers: {
			"x-github-delivery": "d1",
			"x-github-event": "ping",
			"x-hub-signature-256": signature,
		},
		...over,
	} as VercelRequest;
}

async function call(
	handler: ReturnType<typeof createReviewerWebhookHandler>,
	req: VercelRequest,
) {
	const res = stubRes();
	await handler(req, res as unknown as VercelResponse);
	return res;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	readRawBody.mockReset().mockResolvedValue(Buffer.from(PAYLOAD, "utf8"));
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	resetConfigForTests();
});

afterEach(() => {
	warn.mockRestore();
	for (const key of Object.keys(process.env)) {
		if (!(key in SNAPSHOT)) delete process.env[key];
	}
	Object.assign(process.env, SNAPSHOT);
	resetConfigForTests();
});

describe("createReviewerWebhookHandler routing", () => {
	it("rejects non-POST with 405", async () => {
		claudeEnv();
		const res = await call(
			createReviewerWebhookHandler(),
			stubReq({ method: "GET" }),
		);
		expect(res.statusCode).toBe(405);
		expect(res.headers.Allow).toBe("POST");
	});

	it.each([
		["unknown", "nope"],
		["__proto__", "__proto__"],
		["constructor", "constructor"],
		["toString", "toString"],
		["uppercase", "Claude"],
		["300 characters", "a".repeat(300)],
		["array", ["claude", "codex"]],
		["missing", undefined],
	])("unknown id (%s) returns 404 and never reads the body", async (_label, id) => {
		claudeEnv();
		const res = await call(
			createReviewerWebhookHandler(),
			stubReq({ query: { id } as VercelRequest["query"] }),
		);
		expect(res.statusCode).toBe(404);
		expect(readRawBody).not.toHaveBeenCalled();
	});

	it("returns 404 before checking headers or the signature", async () => {
		claudeEnv();
		const res = await call(
			createReviewerWebhookHandler(),
			stubReq({ query: { id: "nope" }, headers: {} }),
		);
		expect(res.statusCode).toBe(404);
	});

	it("disabled reviewer returns 503 without reading the body", async () => {
		geminiEnv({ AI_REVIEW_REVIEWERS__GEMINI__ENABLED: "false" });
		const res = await call(
			createReviewerWebhookHandler(),
			stubReq({ query: { id: "gemini" } }),
		);
		expect(res.statusCode).toBe(503);
		expect(JSON.stringify(res.body)).toContain("reviewers.gemini.enabled");
		expect(readRawBody).not.toHaveBeenCalled();
	});

	it("enabled reviewer missing its private key returns 503 and does not throw", async () => {
		geminiEnv();
		delete process.env.AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY;
		const res = await call(
			createReviewerWebhookHandler(),
			stubReq({ query: { id: "gemini" } }),
		);
		expect(res.statusCode).toBe(503);
		expect(readRawBody).not.toHaveBeenCalled();
	});

	it("emits one cold-start log line with env var names and no secret values", async () => {
		geminiEnv();
		delete process.env.AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY;
		const handler = createReviewerWebhookHandler();
		await call(handler, stubReq({ query: { id: "gemini" } }));
		await call(handler, stubReq({ query: { id: "gemini" } }));
		const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
		const gemini = lines.filter((l: string) => l.includes("reviewer gemini"));
		expect(gemini).toHaveLength(1);
		expect(gemini[0]).toContain("AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY");
		const all = JSON.stringify(warn.mock.calls);
		for (const secret of ["shared-secret", "g-key", "MIIEvgIB"]) {
			expect(all).not.toContain(secret);
		}
	});

	it("valid signature returns 202 and bad signature returns 400 for gemini", async () => {
		geminiEnv();
		const handler = createReviewerWebhookHandler();
		const ok = await call(handler, stubReq({ query: { id: "gemini" } }));
		expect(ok.statusCode).toBe(202);
		const bad = await call(
			handler,
			stubReq({ query: { id: "gemini" } }, sign("wrong")),
		);
		expect(bad.statusCode).toBe(400);
	});

	it("missing GitHub headers return 400 for a known reviewer", async () => {
		geminiEnv();
		const res = await call(
			createReviewerWebhookHandler(),
			stubReq({ query: { id: "gemini" }, headers: {} }),
		);
		expect(res.statusCode).toBe(400);
	});
});

describe("legacy wrappers", () => {
	it("claude wrapper handles a valid signed event and rejects a bad one", async () => {
		claudeEnv();
		const handler = createReviewerWebhookHandler("claude");
		const ok = await call(handler, stubReq({}, sign("claude-secret")));
		expect(ok.statusCode).toBe(202);
		const bad = await call(handler, stubReq({}, sign("codex-secret")));
		expect(bad.statusCode).toBe(400);
	});

	it("codex wrapper handles a valid signed event and rejects a bad one", async () => {
		codexEnv();
		const handler = createReviewerWebhookHandler("codex");
		const ok = await call(handler, stubReq({}, sign("codex-secret")));
		expect(ok.statusCode).toBe(202);
		const bad = await call(handler, stubReq({}, sign("claude-secret")));
		expect(bad.statusCode).toBe(400);
	});

	it("the wrappers ignore a query id and stay on their own reviewer", async () => {
		claudeEnv();
		const handler = createReviewerWebhookHandler("claude");
		const res = await call(
			handler,
			stubReq({ query: { id: "nope" } }, sign("claude-secret")),
		);
		expect(res.statusCode).toBe(202);
	});

	it("the shared secret verifies claude when it has no secret of its own", async () => {
		claudeEnv({ AI_REVIEW_GITHUB__WEBHOOK_SECRET: "shared-secret" });
		delete process.env.GITHUB_WEBHOOK_SECRET;
		const res = await call(
			createReviewerWebhookHandler("claude"),
			stubReq({}, sign("shared-secret")),
		);
		expect(res.statusCode).toBe(202);
	});

	it("the api files delegate to the right reviewer", async () => {
		claudeEnv();
		codexEnv();
		const claude = (await import("../api/github/webhook.js")).default;
		const codex = (await import("../api/github/webhook-openai.js")).default;
		expect(
			(await call(claude, stubReq({}, sign("claude-secret")))).statusCode,
		).toBe(202);
		expect(
			(await call(codex, stubReq({}, sign("codex-secret")))).statusCode,
		).toBe(202);
		expect(
			(await call(claude, stubReq({}, sign("codex-secret")))).statusCode,
		).toBe(400);
	});
});

describe("getReviewerGitHubApp", () => {
	it("memoizes per id and uses the shared secret when the reviewer has none", async () => {
		geminiEnv();
		const first = getReviewerGitHubApp("gemini");
		expect(getReviewerGitHubApp("gemini")).toBe(first);
		expect(await first.webhooks.verify(PAYLOAD, sign("shared-secret"))).toBe(
			true,
		);
	});

	it("throws UnknownReviewerError for an unknown id", () => {
		claudeEnv();
		expect(() => getReviewerGitHubApp("__proto__")).toThrow(
			UnknownReviewerError,
		);
	});

	it("throws ReviewerNotReadyError for a disabled reviewer", () => {
		geminiEnv({ AI_REVIEW_REVIEWERS__GEMINI__ENABLED: "false" });
		expect(() => getReviewerGitHubApp("gemini")).toThrow(ReviewerNotReadyError);
	});
});
