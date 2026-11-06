import { describe, expect, it, vi } from "vitest";
import {
	mapWithConcurrency,
	mapWithConcurrencyByGroup,
} from "./concurrency.js";

describe("mapWithConcurrency", () => {
	it("limit 1 runs strictly sequentially, preserving order", async () => {
		const active: number[] = [];
		let peak = 0;
		const out = await mapWithConcurrency([1, 2, 3], 1, async (n) => {
			active.push(n);
			peak = Math.max(peak, active.length);
			await new Promise((r) => setTimeout(r, 1));
			active.pop();
			return n * 10;
		});
		expect(out).toEqual([10, 20, 30]);
		expect(peak).toBe(1);
	});

	it("respects a higher limit and still returns input order", async () => {
		const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n + 100);
		expect(out).toEqual([101, 102, 103, 104]);
	});

	it("runs an onEach hook between items (for pacing)", async () => {
		const seen: number[] = [];
		await mapWithConcurrency([1, 2], 1, async (n) => n, {
			onBeforeEach: (i) => {
				seen.push(i);
			},
		});
		expect(seen).toEqual([0, 1]);
	});

	it("propagates rejection from fn (errors are not swallowed)", async () => {
		await expect(
			mapWithConcurrency([1], 1, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	it("returns [] for empty input without calling fn", async () => {
		const fn = vi.fn(async (n: number) => n);
		expect(await mapWithConcurrency([], 1, fn)).toEqual([]);
		expect(fn).not.toHaveBeenCalled();
	});

	it("serialFirst finishes item 0 before any other item starts", async () => {
		const events: string[] = [];
		await mapWithConcurrency(
			[0, 1, 2, 3],
			3,
			async (n) => {
				events.push(`start${n}`);
				await new Promise((r) => setTimeout(r, 5));
				events.push(`end${n}`);
				return n;
			},
			{ serialFirst: true },
		);
		expect(events.indexOf("end0")).toBeLessThan(events.indexOf("start1"));
		expect(events.indexOf("end0")).toBeLessThan(events.indexOf("start2"));
		expect(events.indexOf("end0")).toBeLessThan(events.indexOf("start3"));
	});

	it("serialFirst still reaches the full limit for the remainder and keeps order", async () => {
		const active: number[] = [];
		let peak = 0;
		const out = await mapWithConcurrency(
			[0, 1, 2, 3, 4],
			3,
			async (n) => {
				active.push(n);
				peak = Math.max(peak, active.length);
				await new Promise((r) => setTimeout(r, 5));
				active.pop();
				return n * 2;
			},
			{ serialFirst: true },
		);
		expect(out).toEqual([0, 2, 4, 6, 8]);
		expect(peak).toBe(3);
	});

	it("limit 2 actually reaches concurrency 2", async () => {
		const active: number[] = [];
		let peak = 0;
		await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
			active.push(n);
			peak = Math.max(peak, active.length);
			await new Promise((r) => setTimeout(r, 5));
			active.pop();
			return n;
		});
		expect(peak).toBe(2);
	});
});

describe("mapWithConcurrencyByGroup", () => {
	it("finishes each group before the next, warming each group alone, results in input order", async () => {
		const events: string[] = [];
		const items = ["a1", "b1", "a2", "b2"];
		const out = await mapWithConcurrencyByGroup(
			items,
			(item) => item[0] as string,
			4,
			async (item) => {
				events.push(`start:${item}`);
				await new Promise((r) => setTimeout(r, item.endsWith("1") ? 5 : 1));
				events.push(`end:${item}`);
				return item.toUpperCase();
			},
		);
		expect(out).toEqual(["A1", "B1", "A2", "B2"]);
		expect(events).toEqual([
			"start:a1",
			"end:a1",
			"start:a2",
			"end:a2",
			"start:b1",
			"end:b1",
			"start:b2",
			"end:b2",
		]);
	});

	it("passes whole-input indexes to fn and onBeforeEach", async () => {
		const before: number[] = [];
		const seen: number[] = [];
		await mapWithConcurrencyByGroup(
			["a", "b", "a"],
			(item) => item,
			1,
			async (_item, i) => {
				seen.push(i);
			},
			{ onBeforeEach: async (i) => void before.push(i) },
		);
		expect(seen).toEqual([0, 2, 1]);
		expect(before).toEqual([0, 2, 1]);
	});

	it("with one group behaves like mapWithConcurrency with serialFirst", async () => {
		const run = async (
			mapper: (log: string[]) => Promise<number[]>,
		): Promise<[number[], string[]]> => {
			const log: string[] = [];
			return [await mapper(log), log];
		};
		const fn = (log: string[]) => async (n: number) => {
			log.push(`s${n}`);
			await new Promise((r) => setTimeout(r, n === 1 ? 5 : 1));
			log.push(`e${n}`);
			return n;
		};
		const items = [1, 2, 3];
		const grouped = await run((log) =>
			mapWithConcurrencyByGroup(items, () => "g", 2, fn(log)),
		);
		const plain = await run((log) =>
			mapWithConcurrency(items, 2, fn(log), { serialFirst: true }),
		);
		expect(grouped).toEqual(plain);
	});
});
