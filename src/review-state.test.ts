import { describe, expect, it, vi } from "vitest";
import type { KvClient } from "./feedback/kv.js";
import {
	findingId,
	loadReviewState,
	parseBodyFindings,
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
					severity: "P1",
					status: "open" as const,
				},
			],
			reviewedAt: "2026-06-17T00:00:00Z",
			reviewCount: 0,
		};
		await saveReviewState(client, "anthropic", "o", "r", 7, state);
		expect(await loadReviewState(client, "anthropic", "o", "r", 7)).toEqual({
			...state,
			reviewCount: 1,
		});
	});

	it("returns null when KV is cold and no prior review is given", async () => {
		const { client } = fakeKv();
		expect(await loadReviewState(client, "anthropic", "o", "r", 7)).toBeNull();
	});

	it("loadReviewState reads KV only", async () => {
		const { client, store } = fakeKv();
		expect(await loadReviewState(client, "anthropic", "o", "r", 7)).toBeNull();
		store.set(stateKey("anthropic", "o", "r", 8), "{}");
		expect(await loadReviewState(client, "anthropic", "o", "r", 7)).toBeNull();
	});

	it("treats valid JSON of the wrong shape as cold (returns null)", async () => {
		const { client, store } = fakeKv();
		store.set(
			stateKey("anthropic", "o", "r", 7),
			JSON.stringify({ wrong: "shape" }),
		);
		const result = await loadReviewState(client, "anthropic", "o", "r", 7);
		expect(result).toBeNull();
	});

	// Its sibling (valid JSON, wrong shape) logs a console.warn above; this one
	// hit a bare `catch {}` with no logging at all — an operator debugging a
	// stuck triage gate would have zero trace that the KV entry was corrupt,
	// not merely cold.
	it("logs when the KV entry is corrupt JSON, same as it does for the wrong-shape case", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { client, store } = fakeKv();
			store.set(stateKey("anthropic", "o", "r", 7), "{not valid json");

			const result = await loadReviewState(client, "anthropic", "o", "r", 7);

			expect(result).toBeNull();
			expect(warn).toHaveBeenCalledWith(
				"review-state: KV entry is corrupt JSON; treating as cold",
				expect.objectContaining({
					provider: "anthropic",
					owner: "o",
					repo: "r",
				}),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("maps old 'high' to P1 on KV read", async () => {
		const { client } = fakeKv();
		const state = {
			lastReviewedSha: "abc123",
			event: "REQUEST_CHANGES" as const,
			findings: [
				{
					id: "1",
					path: null,
					line: null,
					title: "Bug",
					severity: "high",
					status: "open" as const,
				},
			],
			reviewedAt: new Date().toISOString(),
		};
		await saveReviewState(client, "anthropic", "o", "r", 1, state);
		const loaded = await loadReviewState(client, "anthropic", "o", "r", 1);
		expect(loaded?.findings[0].severity).toBe("P1");
	});

	it("maps old 'medium' to P2 on KV read", async () => {
		const { client } = fakeKv();
		const state = {
			lastReviewedSha: "abc123",
			event: "COMMENT" as const,
			findings: [
				{
					id: "2",
					path: null,
					line: null,
					title: "Nit",
					severity: "medium",
					status: "open" as const,
				},
			],
			reviewedAt: new Date().toISOString(),
		};
		await saveReviewState(client, "anthropic", "o", "r", 2, state);
		const loaded = await loadReviewState(client, "anthropic", "o", "r", 2);
		expect(loaded?.findings[0].severity).toBe("P2");
	});

	it("maps old 'low' to P3 on KV read", async () => {
		const { client } = fakeKv();
		const state = {
			lastReviewedSha: "abc123",
			event: "COMMENT" as const,
			findings: [
				{
					id: "3",
					path: null,
					line: null,
					title: "Style",
					severity: "low",
					status: "open" as const,
				},
			],
			reviewedAt: new Date().toISOString(),
		};
		await saveReviewState(client, "anthropic", "o", "r", 3, state);
		const loaded = await loadReviewState(client, "anthropic", "o", "r", 3);
		expect(loaded?.findings[0].severity).toBe("P3");
	});

	it("passes through P0–P3 values unchanged", async () => {
		const { client } = fakeKv();
		const state = {
			lastReviewedSha: "abc123",
			event: "REQUEST_CHANGES" as const,
			findings: [
				{
					id: "4",
					path: null,
					line: null,
					title: "Critical",
					severity: "P0",
					status: "open" as const,
				},
			],
			reviewedAt: new Date().toISOString(),
		};
		await saveReviewState(client, "anthropic", "o", "r", 4, state);
		const loaded = await loadReviewState(client, "anthropic", "o", "r", 4);
		expect(loaded?.findings[0].severity).toBe("P0");
	});
});

describe("reviewCount", () => {
	it("defaults to 0 for a cold KV", async () => {
		const { client } = fakeKv();
		const loaded = await loadReviewState(client, "anthropic", "o", "r", 1);
		expect(loaded).toBeNull();
	});

	it("starts at 0 and increments to 1 on first save", async () => {
		const { client } = fakeKv();
		const state = {
			lastReviewedSha: "sha1",
			event: "COMMENT" as const,
			findings: [],
			reviewedAt: new Date().toISOString(),
			reviewCount: 0,
		};
		await saveReviewState(client, "anthropic", "o", "r", 5, state);
		const loaded = await loadReviewState(client, "anthropic", "o", "r", 5);
		expect(loaded?.reviewCount).toBe(1);
	});

	it("increments reviewCount on each save", async () => {
		const { client } = fakeKv();
		const base = {
			lastReviewedSha: "sha1",
			event: "COMMENT" as const,
			findings: [],
			reviewedAt: new Date().toISOString(),
			reviewCount: 0,
		};
		await saveReviewState(client, "anthropic", "o", "r", 6, base);
		const after1 = await loadReviewState(client, "anthropic", "o", "r", 6);
		expect(after1?.reviewCount).toBe(1);

		if (!after1) throw new Error("expected after1 to be non-null");
		await saveReviewState(client, "anthropic", "o", "r", 6, after1);
		const after2 = await loadReviewState(client, "anthropic", "o", "r", 6);
		expect(after2?.reviewCount).toBe(2);
	});

	it("tolerates old records missing reviewCount (defaults to 0 before increment)", async () => {
		const { client, store } = fakeKv();
		const key = stateKey("anthropic", "o", "r", 7);
		const oldRecord = JSON.stringify({
			lastReviewedSha: "sha1",
			event: "COMMENT",
			findings: [],
			reviewedAt: new Date().toISOString(),
		});
		store.set(key, oldRecord);
		const loaded = await loadReviewState(client, "anthropic", "o", "r", 7);
		expect(loaded?.reviewCount).toBe(0);
	});

	it("parseBodyFindings returns the rows of a review body", () => {
		const body = [
			"<!-- ai-review:sha=abc1234567890 -->",
			"| Sev | Category | Finding |",
			"|---|---|---|",
			"| 🟠 | bug | **Missing null check** |",
			"| 🟡 | **Unused import** |",
		].join("\n");
		expect(parseBodyFindings(body)).toEqual([
			{
				id: findingId(null, null, "Missing null check"),
				path: null,
				line: null,
				title: "Missing null check",
				severity: "P1",
				status: "open",
			},
			{
				id: findingId(null, null, "Unused import"),
				path: null,
				line: null,
				title: "Unused import",
				severity: "P2",
				status: "open",
			},
		]);
	});
});
