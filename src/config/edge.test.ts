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
		const cold = base({ AI_REVIEW_REVIEW__TIER2_ENABLED: "false" });
		expect(cold.review.tier2Enabled).toBe(false);
		const result = applyLiveOverrides(cold, {
			AI_REVIEW_REVIEW__TIER2_ENABLED: "true",
		});
		expect(result.config.review.tier2Enabled).toBe(true);
	});

	it("Edge true over a cold false is ignored and reported", () => {
		const cold = base({
			AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: "false",
			AI_REVIEW_REVIEW__ENABLED: "false",
		});
		const result = applyLiveOverrides(cold, {
			AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: true,
			AI_REVIEW_REVIEW__ENABLED: true,
		});
		expect(result.config.reviewers.claude?.enabled).toBe(false);
		expect(result.config.review.enabled).toBe(false);
		expect(result.applied).toEqual([]);
		expect(result.ignored).toHaveLength(2);
		expect(result.ignored.every((i) => /can only disable/.test(i.reason))).toBe(
			true,
		);
	});

	it("Edge false over a cold true applies", () => {
		const result = applyLiveOverrides(base(), {
			AI_REVIEW_REVIEW__ENABLED: false,
		});
		expect(result.config.review.enabled).toBe(false);
		expect(result.applied).toEqual(["AI_REVIEW_REVIEW__ENABLED"]);
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

	it("warns once per refresh when the read fails, with the message only", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const t = 1000;
		const opts = {
			now: () => t,
			read: async () => {
				throw new Error("down");
			},
		};
		await getEffectiveConfig(opts);
		await getEffectiveConfig(opts);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("down");
		expect(warn.mock.calls[0]).toHaveLength(1);
		warn.mockRestore();
	});

	it("reports a non-Error throw as its string", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await getEffectiveConfig({
			read: async () => {
				throw "plain string failure";
			},
		});
		expect(result.error).toBe("plain string failure");
		warn.mockRestore();
	});

	it("redacts connection URLs and tokens from the error and the warning", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=abc");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await getEffectiveConfig({
			read: async () => {
				throw new Error(
					"fetch https://edge-config.vercel.com/ecfg_1/items?token=abc failed; token=abc",
				);
			},
		});
		const text = `${result.error} ${String(warn.mock.calls[0]?.[0])}`;
		expect(text).not.toContain("abc");
		expect(text).not.toContain("edge-config.vercel.com");
		expect(result.error).toContain("failed");
		warn.mockRestore();
	});

	it("keeps serving the last good overrides when a later read fails", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let t = 1000;
		const read = vi
			.fn()
			.mockResolvedValueOnce({ AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: false })
			.mockRejectedValueOnce(new Error("down"))
			.mockResolvedValueOnce({});
		const opts = { now: () => t, read };
		expect((await getEffectiveConfig(opts)).error).toBeUndefined();
		t += EDGE_CACHE_MS;
		const stale = await getEffectiveConfig(opts);
		expect(stale.config.reviewers.claude?.enabled).toBe(false);
		expect(stale.applied).toEqual(["AI_REVIEW_REVIEWERS__CLAUDE__ENABLED"]);
		expect(stale.error).toContain("down");
		t += EDGE_CACHE_MS - 1;
		await getEffectiveConfig(opts);
		expect(read).toHaveBeenCalledTimes(2);
		t += 1;
		const recovered = await getEffectiveConfig(opts);
		expect(recovered.error).toBeUndefined();
		expect(recovered.config.reviewers.claude?.enabled).toBe(true);
		warn.mockRestore();
	});

	it("falls back to the cold config when no read has ever succeeded", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await getEffectiveConfig({
			read: async () => {
				throw new Error("down");
			},
		});
		expect(result.config).toBe(getConfigTree());
		expect(result.applied).toEqual([]);
		expect(result.error).toContain("down");
		warn.mockRestore();
	});

	it("shares one read between concurrent callers", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		const read = vi.fn(async () => ({
			AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: false,
		}));
		const [a, b] = await Promise.all([
			getEffectiveConfig({ now: () => 1000, read }),
			getEffectiveConfig({ now: () => 1000, read }),
		]);
		expect(read).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
	});

	it("does not let an older slow refresh overwrite a newer good one", async () => {
		vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/x?token=t");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let failSlow: (e: Error) => void = () => {};
		const slow = new Promise<unknown>((_, reject) => {
			failSlow = reject;
		});
		const first = getEffectiveConfig({ now: () => 1000, read: () => slow });
		resetEdgeCacheForTests();
		const good = await getEffectiveConfig({
			now: () => 1001,
			read: async () => ({ AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: false }),
		});
		expect(good.config.reviewers.claude?.enabled).toBe(false);
		failSlow(new Error("late"));
		await first;
		const cached = await getEffectiveConfig({
			now: () => 1002,
			read: async () => {
				throw new Error("must not read");
			},
		});
		expect(cached.config.reviewers.claude?.enabled).toBe(false);
		expect(cached.error).toBeUndefined();
		warn.mockRestore();
	});
});
