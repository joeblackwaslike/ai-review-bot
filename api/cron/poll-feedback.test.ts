import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../../src/config/load.js";
import handler from "./poll-feedback.js";

const KEY =
	"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7\n-----END PRIVATE KEY-----";
const SNAPSHOT = { ...process.env };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	resetConfigForTests();
	Object.assign(process.env, {
		GITHUB_APP_ID: "123",
		GITHUB_APP_PRIVATE_KEY: KEY,
		ANTHROPIC_API_KEY: "sk-ant",
		AI_REVIEW_REVIEWERS__CODEX__ENABLED: "false",
		AI_REVIEW_REVIEWERS__GEMINI__ENABLED: "false",
		CRON_SECRET: "cron",
	});
	delete process.env.GITHUB_WEBHOOK_SECRET;
	delete process.env.AI_REVIEW_GITHUB__WEBHOOK_SECRET;
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const key of Object.keys(process.env)) {
		if (!(key in SNAPSHOT)) delete process.env[key];
	}
	Object.assign(process.env, SNAPSHOT);
	resetConfigForTests();
});

async function call() {
	const res = {
		status: () => res,
		json: () => res,
	};
	await handler(
		{ headers: { authorization: "Bearer wrong" } } as VercelRequest,
		res as unknown as VercelResponse,
	);
}

describe("GET /api/cron/poll-feedback readiness logging", () => {
	it("logs readiness once with env var names only", async () => {
		await call();
		await call();
		const lines = warn.mock.calls
			.map((c) => String(c[0]))
			.filter((l) => l.startsWith("reviewer "));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("GITHUB_WEBHOOK_SECRET");
		expect(lines[0]).not.toContain("sk-ant");
		expect(lines[0]).not.toContain("BEGIN PRIVATE KEY");
	});
});
