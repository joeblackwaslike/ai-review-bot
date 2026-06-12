import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCache,
	getCacheSize,
	isRateLimited,
	purgeExpired,
} from "./cache.js";

beforeEach(() => {
	clearCache();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("isRateLimited", () => {
	it("does not rate limit the first request for a key", () => {
		expect(isRateLimited("install-1", 3)).toBe(false);
	});

	it("allows requests up to and including the limit, then blocks", () => {
		const key = "install-1";
		const limit = 3;
		// Calls 1..3 bring count to exactly `limit` and stay allowed.
		expect(isRateLimited(key, limit)).toBe(false); // count 1
		expect(isRateLimited(key, limit)).toBe(false); // count 2
		expect(isRateLimited(key, limit)).toBe(false); // count 3 == limit
		// The next call is one over the limit and is blocked.
		expect(isRateLimited(key, limit)).toBe(true); // count 4 > limit
	});

	it("resets the counter once the window has elapsed", () => {
		const key = "install-1";
		const limit = 2;
		const windowMs = 1_000;

		expect(isRateLimited(key, limit, windowMs)).toBe(false); // count 1
		expect(isRateLimited(key, limit, windowMs)).toBe(false); // count 2
		expect(isRateLimited(key, limit, windowMs)).toBe(true); // count 3 > limit

		// Advance past the window; the next call behaves like a first request.
		vi.advanceTimersByTime(windowMs + 1);
		expect(isRateLimited(key, limit, windowMs)).toBe(false);
	});

	it("tracks distinct keys independently", () => {
		const limit = 1;
		expect(isRateLimited("a", limit)).toBe(false); // a: count 1
		expect(isRateLimited("a", limit)).toBe(true); // a: count 2 > limit
		// Key b is unaffected by key a hitting its limit.
		expect(isRateLimited("b", limit)).toBe(false); // b: count 1
	});
});

describe("getCacheSize", () => {
	it("reflects the number of distinct active keys", () => {
		expect(getCacheSize()).toBe(0);
		isRateLimited("a");
		isRateLimited("b");
		isRateLimited("a"); // same key, no new entry
		expect(getCacheSize()).toBe(2);
	});

	it("drops expired keys so the cache does not grow unbounded", () => {
		const windowMs = 1_000;
		isRateLimited("a", 10, windowMs);
		isRateLimited("b", 10, windowMs);
		expect(getCacheSize()).toBe(2);

		vi.advanceTimersByTime(windowMs + 1);
		// purgeExpired runs lazily inside isRateLimited; trigger it for a 3rd key.
		isRateLimited("c", 10, windowMs);
		expect(getCacheSize()).toBe(1);
	});
});

describe("purgeExpired", () => {
	it("removes only entries whose window has passed", () => {
		isRateLimited("short", 10, 1_000);
		isRateLimited("long", 10, 10_000);
		expect(getCacheSize()).toBe(2);

		vi.advanceTimersByTime(2_000);
		purgeExpired();
		expect(getCacheSize()).toBe(1);
	});
});
