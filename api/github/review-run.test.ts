import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../../src/config/load.js";
import handler from "./review-run.js";

const readRawBody = vi.hoisted(() => vi.fn());
const verifyQStashSignature = vi.hoisted(() => vi.fn());
const runScheduledReview = vi.hoisted(() => vi.fn());
const getReviewerGitHubApp = vi.hoisted(() => vi.fn());

vi.mock("../../src/http.js", () => ({
	readRawBody: (...args: unknown[]) => readRawBody(...args),
}));
vi.mock("../../src/scheduler.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/scheduler.js")>()),
	verifyQStashSignature: (...args: unknown[]) => verifyQStashSignature(...args),
}));
vi.mock("../../src/github-app.js", () => ({
	getReviewerGitHubApp: (...args: unknown[]) => getReviewerGitHubApp(...args),
	runScheduledReview: (...args: unknown[]) => runScheduledReview(...args),
}));

const KEY =
	"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7\n-----END PRIVATE KEY-----";
const SNAPSHOT = { ...process.env };
const BASE = {
	owner: "o",
	repo: "r",
	pullNumber: 7,
	headSha: "abc",
	action: "synchronize",
	installationId: 1,
};

function claudeEnv() {
	Object.assign(process.env, {
		GITHUB_APP_ID: "123",
		GITHUB_APP_PRIVATE_KEY: KEY,
		GITHUB_WEBHOOK_SECRET: "claude-secret",
		ANTHROPIC_API_KEY: "sk-ant",
	});
}

function stubRes() {
	const res = {
		statusCode: 0,
		body: undefined as unknown,
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(payload: unknown) {
			res.body = payload;
			return res;
		},
		setHeader() {
			return res;
		},
	};
	return res;
}

async function call(body: unknown, signature: string | null = "sig") {
	readRawBody.mockResolvedValue(
		Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
	);
	const res = stubRes();
	await handler(
		{
			method: "POST",
			headers: signature ? { "upstash-signature": signature } : {},
		} as unknown as VercelRequest,
		res as unknown as VercelResponse,
	);
	return res;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	verifyQStashSignature.mockResolvedValue(true);
	runScheduledReview.mockResolvedValue({ status: "reviewed" });
	getReviewerGitHubApp.mockReturnValue({ app: true });
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	resetConfigForTests();
	claudeEnv();
});

afterEach(() => {
	warn.mockRestore();
	for (const key of Object.keys(process.env)) {
		if (!(key in SNAPSHOT)) delete process.env[key];
	}
	Object.assign(process.env, SNAPSHOT);
	resetConfigForTests();
});

describe("review-run request handling", () => {
	it("accepts an old-shape provider-only message and runs it as claude", async () => {
		const res = await call({ ...BASE, provider: "anthropic" });
		expect(res.statusCode).toBe(200);
		expect(getReviewerGitHubApp).toHaveBeenCalledWith("claude");
		expect(runScheduledReview).toHaveBeenCalledTimes(1);
	});

	it("accepts a message carrying both fields", async () => {
		const res = await call({
			...BASE,
			reviewer: "claude",
			provider: "anthropic",
		});
		expect(res.statusCode).toBe(200);
	});

	it("rejects invalid JSON with 400", async () => {
		expect((await call("{nope")).statusCode).toBe(400);
	});

	it("rejects a message with neither field, or an unmapped provider, with 400", async () => {
		for (const body of [BASE, { ...BASE, provider: "gemini" }, "null", "[]"]) {
			const res = await call(body);
			expect(res.statusCode).toBe(400);
			expect(res.body).toEqual({ error: "Invalid or missing reviewer" });
		}
		expect(runScheduledReview).not.toHaveBeenCalled();
	});

	it("returns 404 for an unconfigured reviewer id", async () => {
		const res = await call({ ...BASE, reviewer: "nope" });
		expect(res.statusCode).toBe(404);
		expect(getReviewerGitHubApp).not.toHaveBeenCalled();
	});

	it("returns 503 for a configured reviewer that is not ready", async () => {
		const res = await call({ ...BASE, reviewer: "gemini" });
		expect(res.statusCode).toBe(503);
		expect(getReviewerGitHubApp).not.toHaveBeenCalled();
		expect(runScheduledReview).not.toHaveBeenCalled();
	});

	it("rejects a missing signature header before any reviewer lookup", async () => {
		const res = await call({ ...BASE, provider: "anthropic" }, null);
		expect(res.statusCode).toBe(400);
		expect(getReviewerGitHubApp).not.toHaveBeenCalled();
	});

	it("rejects a bad signature with 401 without touching the reviewer app", async () => {
		verifyQStashSignature.mockResolvedValue(false);
		const res = await call({ ...BASE, provider: "anthropic" });
		expect(res.statusCode).toBe(401);
		expect(getReviewerGitHubApp).not.toHaveBeenCalled();
		expect(runScheduledReview).not.toHaveBeenCalled();
	});

	it("returns 503 instead of throwing when the app lookup raises after verification", async () => {
		getReviewerGitHubApp.mockImplementation(() => {
			throw new Error("not ready");
		});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await call({ ...BASE, provider: "anthropic" });
		expect(res.statusCode).toBe(503);
		err.mockRestore();
	});
});

describe("review-run readiness logging", () => {
	it("logs readiness once per cold start with env var names only", async () => {
		delete process.env.GITHUB_WEBHOOK_SECRET;
		process.env.AI_REVIEW_REVIEWERS__CODEX__ENABLED = "false";
		process.env.AI_REVIEW_REVIEWERS__GEMINI__ENABLED = "false";
		await call({ ...BASE, provider: "anthropic" });
		await call({ ...BASE, provider: "anthropic" });
		const lines = warn.mock.calls
			.map((c) => String(c[0]))
			.filter((l) => l.startsWith("reviewer "));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("GITHUB_WEBHOOK_SECRET");
		expect(lines[0]).not.toContain("sk-ant");
		expect(lines[0]).not.toContain("BEGIN PRIVATE KEY");
	});
});
