import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

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
