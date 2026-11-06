import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CellRecord,
	defaultExperimentsDir,
	ResultsStore,
} from "./store.js";

const record = (over: Partial<CellRecord["key"]> = {}): CellRecord => ({
	key: {
		strategy: "a",
		version: "v1",
		fixtureId: "o/r#1",
		round: 0,
		trial: 0,
		...over,
	},
	provider: "anthropic",
	planHash: "abc",
	at: "2026-11-06T00:00:00.000Z",
	costUsd: 0.5,
	fitIn210s: true,
	failedAttempts: 0,
	cacheTemperature: "cold",
	result: {
		findings: [],
		candidates: [],
		posted: [],
		agentReviews: [],
		usage: {},
		toolCalls: [],
		wallMs: 10,
	},
});

const tmp = () => mkdtempSync(join(tmpdir(), "store-"));

afterEach(() => vi.unstubAllEnvs());

describe("ResultsStore", () => {
	it("appends and reads back records", () => {
		const store = new ResultsStore(tmp(), "abc");
		store.append(record());
		store.append(record({ round: 1 }));
		const { records, skipped } = store.readAll();
		expect(records.map((r) => r.key.round)).toEqual([0, 1]);
		expect(skipped).toBe(0);
	});

	it("hasCell sees stored cells, including from another instance", () => {
		const dir = tmp();
		new ResultsStore(dir, "abc").append(record());
		const resumed = new ResultsStore(dir, "abc");
		expect(resumed.hasCell(record().key)).toBe(true);
		expect(resumed.hasCell(record({ trial: 1 }).key)).toBe(false);
	});

	it("keeps both of two interleaved appends", () => {
		const dir = tmp();
		const a = new ResultsStore(dir, "abc");
		const b = new ResultsStore(dir, "abc");
		a.append(record({ round: 1 }));
		b.append(record({ round: 2 }));
		a.append(record({ round: 3 }));
		expect(a.readAll().records).toHaveLength(3);
	});

	it("skips and counts unreadable lines", () => {
		const dir = tmp();
		const store = new ResultsStore(dir, "abc");
		store.append(record());
		appendFileSync(store.file, "{not json\n");
		appendFileSync(store.file, `${JSON.stringify({ key: 1 })}\n`);
		store.append(record({ round: 1 }));
		const { records, skipped } = store.readAll();
		expect(records).toHaveLength(2);
		expect(skipped).toBe(2);
	});

	it("rejects lines whose nested shape is wrong", () => {
		const store = new ResultsStore(tmp(), "abc");
		const good = record();
		const bad = [
			{ ...good, costUsd: "1" },
			{ ...good, provider: "gemini" },
			{ ...good, result: { ...good.result, posted: "none" } },
			{
				...good,
				result: { ...good.result, usage: { x: { promptTokens: 1 } } },
			},
			{ ...good, result: { ...good.result, findings: [{ title: 5 }] } },
			{ ...good, cacheTemperature: "hot" },
		];
		store.append(good);
		for (const b of bad) appendFileSync(store.file, `${JSON.stringify(b)}\n`);
		const { records, skipped } = store.readAll();
		expect(records).toHaveLength(1);
		expect(skipped).toBe(bad.length);
	});

	it("flags records whose version differs from the registered one", () => {
		const store = new ResultsStore(tmp(), "abc");
		store.append(record());
		store.append(record({ version: "old", round: 1 }));
		const { records } = store.readAll({ a: "v1" });
		expect(records.map((r) => r.stale)).toEqual([false, true]);
	});

	it("never rewrites earlier lines", () => {
		const store = new ResultsStore(tmp(), "abc");
		store.append(record());
		const before = readFileSync(store.file, "utf8");
		store.append(record({ round: 1 }));
		expect(readFileSync(store.file, "utf8").startsWith(before)).toBe(true);
	});

	it("uses AI_REVIEW_EXPERIMENTS_DIR and ignores a blank value", () => {
		vi.stubEnv("AI_REVIEW_EXPERIMENTS_DIR", "/x/y");
		expect(defaultExperimentsDir()).toBe("/x/y");
		vi.stubEnv("AI_REVIEW_EXPERIMENTS_DIR", "   ");
		expect(defaultExperimentsDir()).toMatch(/\.ai-review\/experiments$/);
	});
});
