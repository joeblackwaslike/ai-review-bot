import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeKv } from "./kv.fake.js";

describe("createFakeKv", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("setNx is atomic and honors ttlSeconds as a stale-lock backstop", async () => {
		vi.useFakeTimers();
		const kv = createFakeKv();

		// First claim succeeds; a competing claim on the same key is rejected.
		expect(await kv.setNx("claim", "first", 1200)).toBe(true);
		expect(await kv.setNx("claim", "second", 1200)).toBe(false);
		expect(await kv.get("claim")).toBe("first");

		// Just before TTL the claim still holds.
		vi.advanceTimersByTime(1199_000);
		expect(await kv.setNx("claim", "third", 1200)).toBe(false);

		// After TTL the claim auto-expires and a new claim can be acquired.
		vi.advanceTimersByTime(2_000);
		expect(await kv.get("claim")).toBeNull();
		expect(await kv.setNx("claim", "fourth", 1200)).toBe(true);
		expect(await kv.get("claim")).toBe("fourth");
	});

	it("stores and reads strings with del", async () => {
		const kv = createFakeKv();
		await kv.set("a", "1");
		expect(await kv.get("a")).toBe("1");
		expect(await kv.get("missing")).toBeNull();
		await kv.del("a");
		expect(await kv.get("a")).toBeNull();
	});

	it("zrangebyscore returns members in score order within inclusive bounds", async () => {
		const kv = createFakeKv();
		await kv.zadd("z", 30, "c");
		await kv.zadd("z", 10, "a");
		await kv.zadd("z", 20, "b");
		expect(await kv.zrangebyscore("z", 15, "+inf")).toEqual(["b", "c"]);
		expect(await kv.zrangebyscore("z", "-inf", 25)).toEqual(["a", "b"]);
	});

	it("zrangebyscore on a missing key returns []", async () => {
		expect(await createFakeKv().zrangebyscore("nope", "-inf", "+inf")).toEqual(
			[],
		);
	});

	it("zremrangebyscore removes matching members and supports exclusive '(' bounds", async () => {
		const kv = createFakeKv();
		await kv.zadd("z", 10, "a");
		await kv.zadd("z", 20, "b");
		const removed = await kv.zremrangebyscore("z", "-inf", "(20");
		expect(removed).toBe(1);
		expect(await kv.zrangebyscore("z", "-inf", "+inf")).toEqual(["b"]);
	});

	it("lpush prepends", async () => {
		const kv = createFakeKv();
		await kv.lpush("l", "x");
		await kv.lpush("l", "y");
		expect(kv._dump().lists.get("l")).toEqual(["y", "x"]);
	});
});
