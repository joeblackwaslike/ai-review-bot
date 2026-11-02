import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelReview } from "../review.js";
import { findingKey, findingRecords, openMistakeLog } from "./log.js";
import { type AgentReview, MistakeRecord } from "./types.js";

const base = {
	severity: "P2" as const,
	category: "bug" as const,
	confidence: 0.9,
	evidence: "e",
	suppressible: false,
};

function review(
	inline: { path: string; title: string }[],
	general: { title: string }[] = [],
): ModelReview {
	return {
		event: "COMMENT",
		general_findings: general.map((g) => ({ ...base, ...g, body: "b" })),
		inline_comments: inline.map((c) => ({
			...base,
			...c,
			body: "b",
			line: 3,
			start_line: null,
			suggestion: null,
		})),
	};
}

function run(
	root: string,
	note: string,
	now = () => new Date("2026-11-02T00:00:00.000Z"),
) {
	const log = openMistakeLog({
		root,
		owner: "o",
		repo: "r",
		source: "review",
		branch: "b",
		now,
	});
	log.append({
		type: "event",
		findingId: "f",
		status: "fixed",
		by: "agent",
		atHead: null,
		fixCommit: null,
		path: null,
		title: "t",
		severity: "P1",
		note,
	});
	return log;
}

afterEach(() => vi.restoreAllMocks());

describe("findingKey", () => {
	it("is stable and insensitive to title case and whitespace", () => {
		expect(findingKey({ path: "a.ts", title: " Foo Bar " })).toBe(
			findingKey({ path: "a.ts", title: "foo bar" }),
		);
		expect(findingKey({ path: "a.ts", title: "x" })).toMatch(/^[0-9a-f]{12}$/);
	});

	it("differs by path", () => {
		expect(findingKey({ path: "a.ts", title: "x" })).not.toBe(
			findingKey({ path: "b.ts", title: "x" }),
		);
	});
});

describe("openMistakeLog", () => {
	it("writes v1 lines that parse as MistakeRecord", () => {
		const root = mkdtempSync(join(tmpdir(), "ml-"));
		const log = run(root, "hello");
		const line = readFileSync(log.path, "utf-8").trim();
		const rec = MistakeRecord.parse(JSON.parse(line));
		expect(rec.v).toBe(1);
		expect(rec.repo).toBe("o/r");
		expect(rec.runId).toBe(log.runId);
	});

	it("keeps newlines, quotes, unicode and 100 KB on one line", () => {
		const root = mkdtempSync(join(tmpdir(), "ml-"));
		const note = `a\n"q"☃${"x".repeat(100_000)}`;
		const log = run(root, note);
		const lines = readFileSync(log.path, "utf-8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string).note).toBe(note);
	});

	it("uses different files for two logs with the same now", () => {
		const root = mkdtempSync(join(tmpdir(), "ml-"));
		expect(run(root, "a").path).not.toBe(run(root, "b").path);
	});

	it("does not throw and warns once when the root is unwritable", () => {
		const dir = mkdtempSync(join(tmpdir(), "ml-"));
		const file = join(dir, "file");
		writeFileSync(file, "x");
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = run(file, "a");
		for (let i = 0; i < 2; i++) {
			log.append({
				type: "event",
				findingId: "f",
				status: "open",
				by: "agent",
				atHead: null,
				fixCommit: null,
				path: null,
				title: "t",
				severity: "P1",
				note: null,
			});
		}
		expect(err).toHaveBeenCalledTimes(1);
	});
});

describe("findingRecords", () => {
	it("emits one row per agent finding and marks survivors", () => {
		const agentReviews: AgentReview[] = [
			{
				provider: "anthropic",
				model: "m",
				skill: "s1",
				review: review([{ path: "a.ts", title: "Keep" }], [{ title: "Gen" }]),
			},
			{
				provider: "openai",
				model: "m2",
				skill: "s2",
				review: review([{ path: "a.ts", title: "Lost" }]),
			},
		];
		const merged = review(
			[{ path: "a.ts", title: "keep" }],
			[{ title: "gen" }],
		);
		const rows = findingRecords({ agentReviews, merged });
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => [r.title, r.survived])).toEqual([
			["Gen", true],
			["Keep", true],
			["Lost", false],
		]);
		expect(rows[2]?.skill).toBe("s2");
		expect(rows[0]?.path).toBeNull();
	});
});
