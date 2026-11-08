import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSpike } from "./run.js";
import type { SpikeItem, SpikeJudge } from "./types.js";

const item = (id: string, over: Partial<SpikeItem> = {}): SpikeItem => ({
	id,
	fixtureId: "fx",
	producer: "anthropic",
	confirmed: true,
	label: "rejected",
	owner: "o",
	repo: "r",
	headSha: "sha",
	path: "src/a.ts",
	line: 3,
	severity: "P2",
	title: `title ${id}`,
	text: `text ${id}`,
	...over,
});

const judge = (id: string, over: Partial<SpikeJudge> = {}): SpikeJudge => ({
	id,
	tier: "cheap",
	vendor: "openai",
	model: "gpt-6-luna",
	effort: "none",
	...over,
});

const dir = () => mkdtempSync(join(tmpdir(), "verifier-run-"));

const verdict = {
	refuted: true,
	reason: "pure_style" as const,
	rationale: "style only",
	costUsd: 0.01,
};

describe("runSpike", () => {
	it("calls every judge for every item once", async () => {
		const call = vi.fn(async () => verdict);
		const { results } = await runSpike({
			items: [item("a"), item("b")],
			judgesFor: () => [judge("j1"), judge("j2", { tier: "mid" })],
			fileFor: async () => "file",
			call,
			cacheDir: dir(),
		});
		expect(call).toHaveBeenCalledTimes(4);
		expect(results).toHaveLength(4);
		expect(results[0]).toMatchObject({
			itemId: "a",
			judgeId: "j1",
			outcome: { kind: "verdict", refuted: true },
		});
	});

	it("serves a repeat run from the cache and spends nothing", async () => {
		const cacheDir = dir();
		const call = vi.fn(async () => verdict);
		const base = {
			items: [item("a")],
			judgesFor: () => [judge("j1")],
			fileFor: async () => "file",
			call,
			cacheDir,
		};
		await runSpike(base);
		const second = await runSpike(base);
		expect(call).toHaveBeenCalledTimes(1);
		expect(second.spentUsd).toBe(0);
		expect(second.results[0]?.outcome).toMatchObject({ kind: "verdict" });
	});

	it("marks an item unverified, without calling a model, when its file is unavailable", async () => {
		const call = vi.fn(async () => verdict);
		const { results } = await runSpike({
			items: [item("a")],
			judgesFor: () => [judge("j1")],
			fileFor: async () => null,
			call,
			cacheDir: dir(),
		});
		expect(call).not.toHaveBeenCalled();
		expect(results[0]?.outcome).toMatchObject({
			kind: "unverified",
			why: expect.stringContaining("file"),
		});
	});

	it("marks a failed call unverified with the error and carries on", async () => {
		const call = vi
			.fn()
			.mockRejectedValueOnce(new Error("429 rate limited"))
			.mockResolvedValue(verdict);
		const { results } = await runSpike({
			items: [item("a"), item("b")],
			judgesFor: () => [judge("j1")],
			fileFor: async () => "file",
			call,
			cacheDir: dir(),
		});
		expect(results[0]?.outcome).toMatchObject({
			kind: "unverified",
			why: expect.stringContaining("429"),
		});
		expect(results[1]?.outcome).toMatchObject({ kind: "verdict" });
	});

	it("does not cache an unverified result, so a rerun retries it", async () => {
		const cacheDir = dir();
		const call = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue(verdict);
		const base = {
			items: [item("a")],
			judgesFor: () => [judge("j1")],
			fileFor: async () => "file",
			call,
			cacheDir,
		};
		await runSpike(base);
		const second = await runSpike(base);
		expect(second.results[0]?.outcome).toMatchObject({ kind: "verdict" });
	});

	it("stops calling models once the cost cap is reached and says so", async () => {
		const call = vi.fn(async () => ({ ...verdict, costUsd: 0.6 }));
		const { results, capped, spentUsd } = await runSpike({
			items: [item("a"), item("b"), item("c")],
			judgesFor: () => [judge("j1")],
			fileFor: async () => "file",
			call,
			cacheDir: dir(),
			maxCostUsd: 1,
			concurrency: 1,
		});
		expect(capped).toBe(true);
		expect(call).toHaveBeenCalledTimes(2);
		expect(spentUsd).toBeCloseTo(1.2);
		expect(results).toHaveLength(2);
	});

	it("keeps verdicts from different models apart in the cache", async () => {
		const cacheDir = dir();
		const call = vi.fn(async () => verdict);
		await runSpike({
			items: [item("a")],
			judgesFor: () => [judge("j1")],
			fileFor: async () => "file",
			call,
			cacheDir,
		});
		await runSpike({
			items: [item("a")],
			judgesFor: () => [judge("j1", { model: "gpt-6.1-sol", tier: "mid" })],
			fileFor: async () => "file",
			call,
			cacheDir,
		});
		expect(call).toHaveBeenCalledTimes(2);
	});

	it("skips a corrupt cache line and still uses the rest", async () => {
		const cacheDir = dir();
		const call = vi.fn(async () => verdict);
		const base = {
			items: [item("a"), item("b")],
			judgesFor: () => [judge("j1")],
			fileFor: async () => "file",
			call,
			cacheDir,
		};
		await runSpike(base);
		const file = join(cacheDir, "verdicts.jsonl");
		const good = readFileSync(file, "utf8");
		writeFileSync(file, `${good}{"key":"half a li`);
		call.mockClear();
		const second = await runSpike(base);
		expect(call).not.toHaveBeenCalled();
		expect(second.results).toHaveLength(2);
	});

	it("puts a file-fetch error in the unverified reason instead of calling it a missing file", async () => {
		const { results } = await runSpike({
			items: [item("a")],
			judgesFor: () => [judge("j1")],
			fileFor: async () => {
				throw new Error("403 Forbidden");
			},
			call: vi.fn(),
			cacheDir: dir(),
		});
		expect(results[0]?.outcome).toMatchObject({
			kind: "unverified",
			why: expect.stringContaining("403 Forbidden"),
		});
	});

	it("asks the judge again when the finding's text changes", async () => {
		const cacheDir = dir();
		const call = vi.fn(async () => verdict);
		const run = (text: string) =>
			runSpike({
				items: [item("a", { text })],
				judgesFor: () => [judge("j1")],
				fileFor: async () => "file",
				call,
				cacheDir,
			});
		await run("first wording");
		await run("first wording");
		expect(call).toHaveBeenCalledTimes(1);
		await run("corrected wording");
		expect(call).toHaveBeenCalledTimes(2);
	});

	it("still serves cached verdicts after the cap is reached, and is not capped when only they remain", async () => {
		const cacheDir = dir();
		const call = vi.fn(async () => ({ ...verdict, costUsd: 1 }));
		const make = (ids: string[]) => ({
			items: ids.map((id) => item(id)),
			judgesFor: () => [judge("j1")],
			fileFor: async () => "file",
			call,
			cacheDir,
			maxCostUsd: 0.5,
			concurrency: 1,
		});
		await runSpike(make(["a"]));
		const second = await runSpike(make(["b", "a"]));
		expect(second.results.map((r) => r.itemId)).toEqual(["b", "a"]);
		expect(second.capped).toBe(false);
		const third = await runSpike(make(["c", "d"]));
		expect(third.capped).toBe(true);
		expect(third.results.map((r) => r.itemId)).toEqual(["c"]);
	});

	it("keeps a paid verdict when the cache cannot be written", async () => {
		const cacheDir = dir();
		chmodSync(cacheDir, 0o500);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { results } = await runSpike({
				items: [item("a")],
				judgesFor: () => [judge("j1")],
				fileFor: async () => "file",
				call: vi.fn(async () => verdict),
				cacheDir,
			});
			expect(results[0]?.outcome).toMatchObject({ kind: "verdict" });
			expect(warn).toHaveBeenCalled();
		} finally {
			chmodSync(cacheDir, 0o700);
			warn.mockRestore();
		}
	});

	it("keeps a verdict written right after a truncated cache tail", async () => {
		const cacheDir = dir();
		const call = vi.fn(async () => verdict);
		const make = (ids: string[]) => ({
			items: ids.map((id) => item(id)),
			judgesFor: () => [judge("j1")],
			fileFor: async () => "file",
			call,
			cacheDir,
		});
		await runSpike(make(["a"]));
		const file = join(cacheDir, "verdicts.jsonl");
		writeFileSync(file, `${readFileSync(file, "utf8")}{"key":"cut off mid-li`);
		await runSpike(make(["a", "b"]));
		call.mockClear();
		const third = await runSpike(make(["a", "b"]));
		expect(call).not.toHaveBeenCalled();
		expect(third.results).toHaveLength(2);
	});

	it("fails loudly when the cache cannot be read, instead of treating it as empty", async () => {
		const cacheDir = dir();
		mkdirSync(join(cacheDir, "verdicts.jsonl"));
		await expect(
			runSpike({
				items: [item("a")],
				judgesFor: () => [judge("j1")],
				fileFor: async () => "file",
				call: vi.fn(async () => verdict),
				cacheDir,
			}),
		).rejects.toThrow(/verdicts\.jsonl/);
	});
});
