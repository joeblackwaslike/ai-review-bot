import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VerdictCache } from "./cache.js";
import type { VerdictRecord } from "./types.js";

const record = (reason: string): VerdictRecord => ({
	verdict: "real",
	scope: "change",
	reason,
	first: { family: "anthropic", model: "m", promptHash: "h" },
	second: null,
	secondVerdict: null,
	status: "single-family",
});

const newDir = () => mkdtempSync(join(tmpdir(), "adj-"));

describe("VerdictCache", () => {
	it("round-trips a record across instances", () => {
		const dir = newDir();
		new VerdictCache(dir).put("snap", "k1", record("one"));
		expect(new VerdictCache(dir).get("snap", "k1")).toEqual(record("one"));
		expect(new VerdictCache(dir).get("snap", "other")).toBeUndefined();
	});

	it("keeps the later of two puts for one key", () => {
		const dir = newDir();
		const cache = new VerdictCache(dir);
		cache.put("snap", "k1", record("first"));
		cache.put("snap", "k1", record("second"));
		expect(new VerdictCache(dir).get("snap", "k1")?.reason).toBe("second");
	});

	it("skips and counts unreadable lines", () => {
		const dir = newDir();
		new VerdictCache(dir).put("snap", "k1", record("ok"));
		appendFileSync(join(dir, "snap.jsonl"), "{not json\n");
		const cache = new VerdictCache(dir);
		expect(cache.get("snap", "k1")?.reason).toBe("ok");
		expect(cache.skippedLines).toBe(1);
	});

	it("treats a missing file as empty", () => {
		const cache = new VerdictCache(newDir());
		expect(cache.get("none", "k")).toBeUndefined();
	});

	it("keeps entries put by two instances on one snapshot", () => {
		const dir = newDir();
		const a = new VerdictCache(dir);
		const b = new VerdictCache(dir);
		a.get("snap", "warm");
		b.get("snap", "warm");
		a.put("snap", "k1", record("from a"));
		b.put("snap", "k2", record("from b"));
		const fresh = new VerdictCache(dir);
		expect(fresh.get("snap", "k1")?.reason).toBe("from a");
		expect(fresh.get("snap", "k2")?.reason).toBe("from b");
	});

	it("never deletes an unreadable line when it puts", () => {
		const dir = newDir();
		appendFileSync(join(dir, "snap.jsonl"), "{not json\n");
		new VerdictCache(dir).put("snap", "k1", record("ok"));
		expect(readFileSync(join(dir, "snap.jsonl"), "utf8")).toContain(
			"{not json",
		);
	});
});
