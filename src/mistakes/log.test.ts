import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelReview } from "../review.js";
import {
	findingKey,
	findingRecords,
	mistakesRoot,
	openMistakeLog,
} from "./log.js";
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

const tempDirs: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "ml-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

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
		const root = tempRoot();
		const log = run(root, "hello");
		const line = readFileSync(log.path, "utf-8").trim();
		const rec = MistakeRecord.parse(JSON.parse(line));
		expect(rec.v).toBe(1);
		expect(rec.repo).toBe("o/r");
		expect(rec.runId).toBe(log.runId);
	});

	it("keeps newlines, quotes, unicode and 100 KB on one line", () => {
		const root = tempRoot();
		const note = `a\n"q"☃${"x".repeat(100_000)}`;
		const log = run(root, note);
		const lines = readFileSync(log.path, "utf-8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string).note).toBe(note);
	});

	it("treats an empty AI_REVIEW_MISTAKES_DIR as unset", () => {
		vi.stubEnv("AI_REVIEW_MISTAKES_DIR", "");
		expect(isAbsolute(mistakesRoot())).toBe(true);
	});

	it("honors AI_REVIEW_MISTAKES_DIR and lays out owner__repo/stamp-runId.jsonl", () => {
		const root = tempRoot();
		vi.stubEnv("AI_REVIEW_MISTAKES_DIR", root);
		const log = openMistakeLog({
			owner: "o",
			repo: "r",
			source: "review",
			branch: null,
			runId: "rid",
			now: () => new Date("2026-11-02T00:00:00.000Z"),
		});
		expect(relative(root, log.path)).toBe(
			join("o__r", "2026-11-02T00-00-00-000Z-rid.jsonl"),
		);
	});

	it("uses different files for two logs with the same now", () => {
		const root = tempRoot();
		expect(run(root, "a").path).not.toBe(run(root, "b").path);
	});

	it("does not throw and warns once when the root is unwritable", () => {
		const dir = tempRoot();
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

describe("MistakeRecord annotation", () => {
	const annotation = {
		v: 1,
		type: "annotation",
		ts: "2026-11-02T00:00:00.000Z",
		runId: "r1",
		repo: "o/r",
		branch: "b",
		implementer: {
			agent: "claude-code",
			sessionId: "s1",
			source: "resolved",
			confidence: "medium",
		},
	};

	it("round-trips an annotation line", () => {
		const rec = MistakeRecord.parse(JSON.parse(JSON.stringify(annotation)));
		expect(rec).toEqual(annotation);
	});

	it("rejects an annotation without an implementer", () => {
		const { implementer: _, ...rest } = annotation;
		expect(MistakeRecord.safeParse(rest).success).toBe(false);
	});

	it("accepts ingest as an event source", () => {
		const rec = MistakeRecord.safeParse({
			v: 1,
			type: "event",
			ts: "t",
			runId: "nm",
			source: "ingest",
			repo: "o/r",
			branch: "b",
			findingId: "f1",
			status: "approved",
			by: "no-mistakes",
			atHead: "aaaa",
			fixCommit: null,
			path: null,
			title: "x",
			severity: "error",
			note: "selected-for-fix",
		});
		expect(rec.success).toBe(true);
	});
});

describe("MistakeRecord source and step", () => {
	const run = {
		v: 1,
		type: "run",
		ts: "t",
		runId: "r1",
		source: "ingest",
		repo: "o/r",
		branch: "b",
		headSha: "aaaa",
		mergeBase: null,
		scope: "range",
		round: 1,
		costUsd: 0,
		durationSeconds: 1,
		providers: [],
		models: [],
		agentsAttempted: 0,
		agentsSucceeded: 0,
		partial: false,
		reportPath: null,
		implementer: {
			agent: null,
			sessionId: null,
			source: null,
			confidence: null,
		},
	};
	const event = {
		v: 1,
		type: "event",
		ts: "t",
		runId: "nm",
		source: "ingest",
		repo: "o/r",
		branch: "b",
		findingId: "f1",
		status: "approved",
		by: "no-mistakes",
		atHead: "aaaa",
		fixCommit: null,
		path: null,
		title: "x",
		severity: "error",
		note: null,
	};

	it("rejects ingest as a run source and accepts review", () => {
		expect(MistakeRecord.safeParse(run).success).toBe(false);
		expect(MistakeRecord.safeParse({ ...run, source: "review" }).success).toBe(
			true,
		);
	});

	it("accepts an event with source ingest, with or without a step", () => {
		const parsed = MistakeRecord.parse(event);
		expect(parsed.type === "event" && parsed.step).toBeUndefined();
		const withStep = MistakeRecord.parse({ ...event, step: "review" });
		expect(withStep.type === "event" && withStep.step).toBe("review");
	});
});

describe("log permissions", () => {
	it.skipIf(process.platform === "win32")(
		"creates the log directory and file without group or other access",
		() => {
			const root = tempRoot();
			const log = run(join(root, "fresh"), "n");
			expect(statSync(log.path).mode & 0o077).toBe(0);
			expect(statSync(dirname(log.path)).mode & 0o077).toBe(0);
		},
	);

	it("keeps the log file under the root for a crafted owner and repo", () => {
		const root = tempRoot();
		const log = openMistakeLog({
			root,
			owner: "../evil",
			repo: "a/b",
			runId: "../../x",
			source: "review",
			branch: "b",
		});
		expect(log.path.startsWith(`${root}/`)).toBe(true);
		expect(relative(root, log.path).split("/")).toHaveLength(2);
	});
});
