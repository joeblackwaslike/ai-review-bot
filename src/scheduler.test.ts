import { beforeEach, describe, expect, it, vi } from "vitest";

const publishJSON = vi.hoisted(() => vi.fn());
const verify = vi.hoisted(() => vi.fn());
vi.mock("@upstash/qstash", () => ({
	Client: vi.fn(() => ({ publishJSON })),
	Receiver: vi.fn(() => ({ verify })),
}));

import { Client } from "@upstash/qstash";
import type { AppConfig } from "./config.js";
import { scheduleReview, verifyQStashSignature } from "./scheduler.js";

beforeEach(() => {
	vi.clearAllMocks();
});

const cfg = {
	qstashToken: "tok",
	qstashCurrentSigningKey: "cur",
	qstashNextSigningKey: "nxt",
	publicUrl: "https://example.test",
} as unknown as AppConfig;

const msg = {
	provider: "anthropic" as const,
	owner: "o",
	repo: "r",
	pullNumber: 7,
	headSha: "abc",
	action: "synchronize",
	installationId: 1,
};

describe("scheduleReview", () => {
	it("publishes a delayed JSON message to the review-run URL with a per-head dedup id", async () => {
		publishJSON.mockResolvedValueOnce({ messageId: "m1" });
		const out = await scheduleReview(cfg, msg, 300);
		expect(out).toEqual({ messageId: "m1" });
		expect(publishJSON).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.test/api/github/review-run",
				body: msg,
				delay: 300,
				deduplicationId: "anthropic:o/r:7:abc",
			}),
		);
	});
	it("returns null when QStash is unconfigured (caller falls back to inline)", async () => {
		const out = await scheduleReview(
			{ ...cfg, qstashToken: undefined },
			msg,
			300,
		);
		expect(out).toBeNull();
		expect(publishJSON).not.toHaveBeenCalled();
	});
	it("returns null on PARTIAL config (signing keys missing) so the review isn't published-then-401-dropped", async () => {
		const out = await scheduleReview(
			{ ...cfg, qstashCurrentSigningKey: undefined },
			msg,
			300,
		);
		expect(out).toBeNull();
		expect(publishJSON).not.toHaveBeenCalled();
	});
	it("returns null when publish throws (QStash outage → inline fallback, never drops)", async () => {
		publishJSON.mockRejectedValueOnce(new Error("qstash down"));
		const out = await scheduleReview(cfg, msg, 300);
		expect(out).toBeNull();
	});
	it("passes the region baseUrl to the QStash Client when qstashUrl is set", async () => {
		publishJSON.mockResolvedValueOnce({ messageId: "m1" });
		await scheduleReview(
			{ ...cfg, qstashUrl: "https://qstash-us-east-1.upstash.io" },
			msg,
			300,
		);
		expect(Client).toHaveBeenCalledWith({
			token: "tok",
			baseUrl: "https://qstash-us-east-1.upstash.io",
		});
	});
	it("omits baseUrl when qstashUrl is unset (SDK default + QSTASH_URL env fallback)", async () => {
		publishJSON.mockResolvedValueOnce({ messageId: "m1" });
		await scheduleReview(cfg, msg, 300);
		expect(Client).toHaveBeenCalledWith({ token: "tok" });
	});
	it("strips a trailing slash from publicUrl so publish/verify URLs match", async () => {
		publishJSON.mockResolvedValueOnce({ messageId: "m1" });
		await scheduleReview(
			{ ...cfg, publicUrl: "https://example.test/" },
			msg,
			300,
		);
		expect(publishJSON).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.test/api/github/review-run",
			}),
		);
	});
});

describe("verifyQStashSignature", () => {
	it("returns true on a valid signature", async () => {
		verify.mockResolvedValueOnce(true);
		expect(await verifyQStashSignature(cfg, "raw-body", "sig")).toBe(true);
		expect(verify).toHaveBeenCalledWith({
			body: "raw-body",
			signature: "sig",
			url: "https://example.test/api/github/review-run",
		});
	});
	it("returns false when verify throws or rejects", async () => {
		verify.mockRejectedValueOnce(new Error("bad"));
		expect(await verifyQStashSignature(cfg, "raw-body", "sig")).toBe(false);
	});
	it("returns false (fails closed) when publicUrl is unconfigured", async () => {
		const out = await verifyQStashSignature(
			{ ...cfg, publicUrl: undefined },
			"raw-body",
			"sig",
		);
		expect(out).toBe(false);
		expect(verify).not.toHaveBeenCalled();
	});
});
