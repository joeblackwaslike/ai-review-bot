import { describe, expect, it } from "vitest";
import { createFakeKv } from "./kv.fake.js";

describe("createFakeKv", () => {
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
