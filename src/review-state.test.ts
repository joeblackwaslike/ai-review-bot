import { describe, expect, it } from "vitest";
import type { KvClient } from "./feedback/kv.js";
import {
	findingId,
	loadReviewState,
	saveReviewState,
	stateKey,
} from "./review-state.js";

function fakeKv() {
	const store = new Map<string, string>();
	return {
		store,
		client: {
			get: async (k: string) => store.get(k) ?? null,
			set: async (k: string, v: string) => void store.set(k, v),
			setNx: async () => true,
			del: async (...ks: string[]) => {
				for (const k of ks) store.delete(k);
			},
		} as unknown as KvClient,
	};
}

describe("review-state", () => {
	it("builds a stable per-bot key", () => {
		expect(stateKey("anthropic", "o", "r", 7)).toBe(
			"review-state:anthropic:o/r#7",
		);
	});

	it("round-trips state through KV", async () => {
		const { client } = fakeKv();
		const state = {
			lastReviewedSha: "abc",
			event: "REQUEST_CHANGES" as const,
			findings: [
				{
					id: findingId("src/a.ts", 5, "Bug"),
					path: "src/a.ts",
					line: 5,
					title: "Bug",
					severity: "high",
					status: "open" as const,
				},
			],
			reviewedAt: "2026-06-17T00:00:00Z",
		};
		await saveReviewState(client, "anthropic", "o", "r", 7, state);
		expect(
			await loadReviewState(client, "anthropic", "o", "r", 7, null),
		).toEqual(state);
	});

	it("returns null when KV is cold and no prior review is given", async () => {
		const { client } = fakeKv();
		expect(
			await loadReviewState(client, "anthropic", "o", "r", 7, null),
		).toBeNull();
	});

	it("falls back to a parsed prior GitHub review when KV is cold", async () => {
		const { client } = fakeKv();
		const prior =
			"### ai-review\nReviewed commit: `deadbee`\n\n| Sev | Finding |\n|---|---|\n| 🔴 | Unsafe eval |";
		const state = await loadReviewState(
			client,
			"anthropic",
			"o",
			"r",
			7,
			prior,
		);
		expect(state?.lastReviewedSha).toBe("deadbee");
		expect(state?.findings.some((f) => f.title.includes("Unsafe eval"))).toBe(
			true,
		);
	});

	it("treats valid JSON of the wrong shape as cold (returns null when no priorOwnReview)", async () => {
		const { client, store } = fakeKv();
		store.set(
			stateKey("anthropic", "o", "r", 7),
			JSON.stringify({ wrong: "shape" }),
		);
		const result = await loadReviewState(
			client,
			"anthropic",
			"o",
			"r",
			7,
			null,
		);
		expect(result).toBeNull();
	});

	it("falls back to priorOwnReview when KV holds valid JSON of the wrong shape", async () => {
		const { client, store } = fakeKv();
		store.set(
			stateKey("anthropic", "o", "r", 7),
			JSON.stringify({ wrong: "shape" }),
		);
		const prior =
			"### ai-review\nReviewed commit: `abc1234`\n\n| Sev | Finding |\n|---|---|\n| 🔴 | Null deref |";
		const result = await loadReviewState(
			client,
			"anthropic",
			"o",
			"r",
			7,
			prior,
		);
		expect(result?.lastReviewedSha).toBe("abc1234");
		expect(result?.findings.some((f) => f.title.includes("Null deref"))).toBe(
			true,
		);
	});
});
