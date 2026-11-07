import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyLiveOverrides,
	EDGE_CACHE_MS,
	getEffectiveConfig,
	resetEdgeCacheForTests,
} from "./edge.js";
import { getConfigTree, loadConfig, resetConfigForTests } from "./load.js";

const base = (env: Record<string, string> = {}) => loadConfig({ env }).config;

afterEach(() => {
	vi.unstubAllEnvs();
	resetEdgeCacheForTests();
	resetConfigForTests();
});

describe("applyLiveOverrides", () => {
	it("applies a live key and re-validates", () => {
		const cold = base();
		const result = applyLiveOverrides(cold, {
			AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: false,
		});
		expect(cold.reviewers.claude?.enabled).toBe(true);
		expect(result.config.reviewers.claude?.enabled).toBe(false);
		expect(result.applied).toEqual(["AI_REVIEW_REVIEWERS__CLAUDE__ENABLED"]);
		expect(result.ignored).toEqual([]);
	});

	it("Edge beats env", () => {
		const cold = base({ AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: "false" });
		expect(cold.reviewers.claude?.enabled).toBe(false);
		const result = applyLiveOverrides(cold, {
			AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: "true",
		});
		expect(result.config.reviewers.claude?.enabled).toBe(true);
	});

	it("ignores a non-live key and reports it", () => {
		const result = applyLiveOverrides(base(), {
			AI_REVIEW_REVIEW__COMMAND: "/x",
		});
		expect(result.applied).toEqual([]);
		expect(result.ignored).toEqual([
			{
				key: "AI_REVIEW_REVIEW__COMMAND",
				reason: expect.stringContaining("not live"),
			},
		]);
	});

	it("ignores an unknown AI_REVIEW key and reports the closest path", () => {
		const result = applyLiveOverrides(base(), {
			AI_REVIEW_REVIEWERS__CLAUDE__ENABLE: false,
		});
		expect(result.ignored[0]?.reason).toContain(
			"AI_REVIEW_REVIEWERS__CLAUDE__ENABLED",
		);
	});

	it("ignores a value that fails the schema (concurrency 0) without dropping other keys", () => {
		const result = applyLiveOverrides(base(), {
			AI_REVIEW_REVIEWERS__CLAUDE__CONCURRENCY: 0,
			AI_REVIEW_REVIEWERS__CODEX__ENABLED: false,
		});
		expect(result.applied).toEqual(["AI_REVIEW_REVIEWERS__CODEX__ENABLED"]);
		expect(result.ignored.map((i) => i.key)).toEqual([
			"AI_REVIEW_REVIEWERS__CLAUDE__CONCURRENCY",
		]);
		expect(result.config.reviewers.codex?.enabled).toBe(false);
	});

	it("ignores a value that fails coercion", () => {
		const result = applyLiveOverrides(base(), {
			AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: "maybe",
		});
		expect(result.applied).toEqual([]);
		expect(result.ignored).toHaveLength(1);
	});

	it("reports __proto__ and constructor keys and leaves prototypes alone", () => {
		const edge = JSON.parse(
			'{"__proto__":{"polluted":true},"constructor":{"x":1}}',
		);
		const result = applyLiveOverrides(base(), edge);
		expect(result.applied).toEqual([]);
		expect(result.ignored.map((i) => i.key).sort()).toEqual([
			"__proto__",
			"constructor",
		]);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("returns a frozen config and does not mutate the base", () => {
		const cold = base();
		const snapshot = structuredClone(cold);
		const result = applyLiveOverrides(cold, {
			AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: false,
		});
		expect(Object.isFrozen(result.config)).toBe(true);
		expect(Object.isFrozen(result.config.reviewers.claude)).toBe(true);
		expect(cold).toEqual(snapshot);
	});
});

describe("getEffectiveConfig", () => {
	it("returns the cold config unchanged and applied empty when EDGE_CONFIG is unset", async () => {
		vi.stubEnv("EDGE_CONFIG", "");
		const read = vi.fn();
		const result = await getEffectiveConfig({ read });
		expect(read).not.toHaveBeenCalled();
		expect(result.config).toBe(getConfigTree());
		expect(result.applied).toEqual([]);
		expect(result.ignored).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("read throwing returns the cold config with error set", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		const result = await getEffectiveConfig({
			read: async () => {
				throw new Error("boom");
			},
		});
		expect(result.error).toContain("boom");
		expect(result.applied).toEqual([]);
	});

	it("a non-object payload is treated as empty", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		const result = await getEffectiveConfig({ read: async () => [1, 2] });
		expect(result.applied).toEqual([]);
		expect(result.ignored).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("times out a hung read", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		vi.useFakeTimers();
		const pending = getEffectiveConfig({ read: () => new Promise(() => {}) });
		await vi.advanceTimersByTimeAsync(2001);
		const result = await pending;
		vi.useRealTimers();
		expect(result.error).toContain("timed out");
	});

	it("caches for 5 seconds and refetches after", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		let t = 1000;
		const read = vi.fn(async () => ({
			AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: false,
		}));
		const opts = { now: () => t, read };
		const first = await getEffectiveConfig(opts);
		expect(first.config.reviewers.claude?.enabled).toBe(false);
		t += EDGE_CACHE_MS - 1;
		await getEffectiveConfig(opts);
		expect(read).toHaveBeenCalledTimes(1);
		t += 1;
		await getEffectiveConfig(opts);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("re-reads after a failed read once the cache expires and recovers", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		let t = 1000;
		const read = vi
			.fn()
			.mockRejectedValueOnce(new Error("down"))
			.mockResolvedValueOnce({ AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: false });
		const opts = { now: () => t, read };
		expect((await getEffectiveConfig(opts)).error).toContain("down");
		t += EDGE_CACHE_MS;
		const recovered = await getEffectiveConfig(opts);
		expect(recovered.error).toBeUndefined();
		expect(recovered.config.reviewers.claude?.enabled).toBe(false);
	});
});
