import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingest } from "./ingest.js";
import { openMistakeLog } from "./log.js";
import type { NoMistakesRound, NoMistakesSource } from "./nomistakes.js";
import { type Implementer, MistakeRecord } from "./types.js";

const TRANSCRIPTS = fileURLToPath(
	new URL("./fixtures/transcripts", import.meta.url),
);
const OWNER = "o";
const REPO = "ai-review-bot";
const SLUG = `${OWNER}/${REPO}`;
const NONE: Implementer = {
	agent: null,
	sessionId: null,
	source: null,
	confidence: null,
};

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ml-ingest-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function capture(
	root: string,
	opts: {
		source: "review" | "gate";
		branch: string | null;
		at: string;
		headSha?: string;
		implementer?: Implementer;
		runId?: string;
	},
): string {
	const log = openMistakeLog({
		root,
		owner: OWNER,
		repo: REPO,
		source: opts.source,
		branch: opts.branch,
		now: () => new Date(opts.at),
		runId: opts.runId,
	});
	log.append({
		type: "run",
		headSha: opts.headSha ?? "aaaa",
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
		implementer: opts.implementer ?? NONE,
	});
	return log.runId;
}

const claude = (sessionId: string): Implementer => ({
	agent: "claude-code",
	sessionId,
	source: "env",
	confidence: "high",
});

function fakeNoMistakes(
	runs: Awaited<ReturnType<NoMistakesSource["runs"]>> = [],
	rounds: Record<string, NoMistakesRound[]> = {},
): NoMistakesSource {
	return {
		runs: vi.fn(async () => runs),
		rounds: vi.fn(async (id: string) => rounds[id] ?? []),
	};
}

function readOutput(file: string | null): MistakeRecord[] {
	if (!file) return [];
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((l) => MistakeRecord.parse(JSON.parse(l)));
}

function run(root: string, extra: Partial<Parameters<typeof ingest>[0]> = {}) {
	return ingest({
		root,
		repo: SLUG,
		transcriptsDir: tempDir(),
		noMistakes: fakeNoMistakes(),
		now: () => new Date("2026-11-02T00:00:00.000Z"),
		...extra,
	});
}

const DECIDED_ROUND: NoMistakesRound = {
	stepName: "gate.review.ai-review",
	stepStatus: "completed",
	stepFindingsJson: null,
	round: 1,
	findingsJson: JSON.stringify({
		findings: [
			{ id: "f1", severity: "error", file: "src/a.ts", description: "Bug" },
		],
	}),
	selectedFindingIds: '["f1"]',
	selectionSource: "user",
	reviewedHeadSha: "aaaa",
};

describe("ingest", () => {
	it("resolves a gate run from the latest earlier review run on the branch", async () => {
		const root = tempDir();
		capture(root, {
			source: "review",
			branch: "feat/x",
			at: "2026-11-01T10:00:00.000Z",
			implementer: claude("s1"),
		});
		capture(root, {
			source: "review",
			branch: "feat/x",
			at: "2026-11-01T09:00:00.000Z",
			implementer: claude("s0"),
		});
		capture(root, {
			source: "review",
			branch: "feat/x",
			at: "2026-11-01T13:00:00.000Z",
			implementer: claude("s-after"),
		});
		capture(root, {
			source: "review",
			branch: "other",
			at: "2026-11-01T11:00:00.000Z",
			implementer: claude("s-other"),
		});
		const gateId = capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
		});

		const res = await run(root);

		expect(res.resolved).toEqual({ byReviewRow: 1, byTranscript: 0 });
		expect(res.unresolved).toBe(0);
		expect(res.file).toMatch(
			/o__ai-review-bot\/ingest-2026-11-02T00-00-00-000Z\.jsonl$/,
		);
		const out = readOutput(res.file);
		expect(out).toEqual([
			{
				v: 1,
				type: "annotation",
				ts: "2026-11-02T00:00:00.000Z",
				runId: gateId,
				repo: SLUG,
				branch: "feat/x",
				implementer: {
					agent: "claude-code",
					sessionId: "s1",
					source: "resolved",
					confidence: "high",
				},
			},
		]);
	});

	it("falls back to the transcript scan with medium confidence", async () => {
		const root = tempDir();
		const gateId = capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
		});

		const res = await run(root, { transcriptsDir: TRANSCRIPTS });

		expect(res.resolved).toEqual({ byReviewRow: 0, byTranscript: 1 });
		const [ann] = readOutput(res.file);
		expect(ann).toMatchObject({
			type: "annotation",
			runId: gateId,
			implementer: {
				agent: "claude-code",
				sessionId: "sess-commit",
				source: "resolved",
				confidence: "medium",
			},
		});
	});

	it("leaves an unmatched gate run unresolved and writes no file", async () => {
		const root = tempDir();
		capture(root, {
			source: "gate",
			branch: "feat/none",
			at: "2026-11-01T12:00:00.000Z",
		});
		capture(root, {
			source: "gate",
			branch: null,
			at: "2026-11-01T12:00:00.000Z",
		});

		const res = await run(root, { transcriptsDir: TRANSCRIPTS });

		expect(res).toEqual({
			resolved: { byReviewRow: 0, byTranscript: 0 },
			unresolved: 2,
			events: 0,
			file: null,
		});
		expect(readdirSync(join(root, `${OWNER}__${REPO}`))).toHaveLength(2);
	});

	it("does not re-resolve a gate run that already carries a session", async () => {
		const root = tempDir();
		capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
			implementer: claude("s-env"),
		});
		const res = await run(root, { transcriptsDir: TRANSCRIPTS });
		expect(res.resolved).toEqual({ byReviewRow: 0, byTranscript: 0 });
		expect(res.unresolved).toBe(0);
		expect(res.file).toBeNull();
	});

	it("writes no-mistakes decisions for a run on a captured branch and head", async () => {
		const root = tempDir();
		capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
			headSha: "aaaa",
			implementer: claude("s-env"),
		});
		const noMistakes = fakeNoMistakes(
			[
				{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa", createdAt: 1 },
				{ id: "NMRUN2", branch: "feat/x", headSha: "zzzz", createdAt: 1 },
				{ id: "NMRUN3", branch: "feat/y", headSha: "aaaa", createdAt: 1 },
			],
			{
				NMRUN1: [DECIDED_ROUND],
				NMRUN2: [{ ...DECIDED_ROUND, reviewedHeadSha: "zzzz" }],
				NMRUN3: [DECIDED_ROUND],
			},
		);

		const res = await run(root, { noMistakes });

		expect(noMistakes.runs).toHaveBeenCalledWith(SLUG);
		expect(noMistakes.rounds).not.toHaveBeenCalledWith("NMRUN3");
		expect(res.events).toBe(1);
		expect(readOutput(res.file)).toEqual([
			{
				v: 1,
				type: "event",
				ts: "2026-11-02T00:00:00.000Z",
				runId: "NMRUN1",
				source: "ingest",
				repo: SLUG,
				branch: "feat/x",
				findingId: "f1",
				status: "approved",
				by: "no-mistakes",
				atHead: "aaaa",
				fixCommit: null,
				path: "src/a.ts",
				title: "Bug",
				severity: "error",
				note: "selected-for-fix",
			},
		]);
	});

	it("matches a no-mistakes run by a reviewed head when the run head differs", async () => {
		const root = tempDir();
		capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
			headSha: "aaaa",
			implementer: claude("s-env"),
		});
		const res = await run(root, {
			noMistakes: fakeNoMistakes(
				[{ id: "NMRUN1", branch: "feat/x", headSha: "0000", createdAt: 1 }],
				{ NMRUN1: [DECIDED_ROUND] },
			),
		});
		expect(res.events).toBe(1);
	});

	it("still annotates when the no-mistakes source fails", async () => {
		const root = tempDir();
		capture(root, {
			source: "review",
			branch: "feat/x",
			at: "2026-11-01T10:00:00.000Z",
			implementer: claude("s1"),
		});
		capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
		});
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await run(root, {
			noMistakes: {
				runs: async () => {
					throw new Error("unable to open database");
				},
				rounds: async () => [],
			},
		});
		expect(res.resolved.byReviewRow).toBe(1);
		expect(res.events).toBe(0);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("unable to open database"),
		);
	});

	it("never changes capture files and skips malformed lines in them", async () => {
		const root = tempDir();
		capture(root, {
			source: "review",
			branch: "feat/x",
			at: "2026-11-01T10:00:00.000Z",
			implementer: claude("s1"),
		});
		capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
		});
		const dir = join(root, `${OWNER}__${REPO}`);
		writeFileSync(join(dir, "2026-11-01T00-00-00-000Z-bad.jsonl"), "{oops\n");
		const hashes = () =>
			Object.fromEntries(
				readdirSync(dir)
					.filter((f) => !f.startsWith("ingest-"))
					.map((f) => [
						f,
						createHash("sha256")
							.update(readFileSync(join(dir, f)))
							.digest("hex"),
					]),
			);
		const before = hashes();
		vi.spyOn(console, "error").mockImplementation(() => {});

		await run(root, {
			transcriptsDir: TRANSCRIPTS,
			noMistakes: fakeNoMistakes(
				[{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa", createdAt: 1 }],
				{ NMRUN1: [DECIDED_ROUND] },
			),
		});

		expect(hashes()).toEqual(before);
	});

	it("is idempotent: a second run with nothing new writes no file", async () => {
		const root = tempDir();
		capture(root, {
			source: "review",
			branch: "feat/x",
			at: "2026-11-01T10:00:00.000Z",
			implementer: claude("s1"),
		});
		capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
		});
		const nm = () =>
			fakeNoMistakes(
				[{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa", createdAt: 1 }],
				{ NMRUN1: [DECIDED_ROUND] },
			);

		const first = await run(root, { noMistakes: nm() });
		const second = await run(root, {
			noMistakes: nm(),
			now: () => new Date("2026-11-03T00:00:00.000Z"),
		});

		expect(first.file).not.toBeNull();
		expect(first.events).toBe(1);
		expect(second).toEqual({
			resolved: { byReviewRow: 0, byTranscript: 0 },
			unresolved: 0,
			events: 0,
			file: null,
		});
		const ingestFiles = readdirSync(join(root, `${OWNER}__${REPO}`)).filter(
			(f) => f.startsWith("ingest-"),
		);
		expect(ingestFiles).toHaveLength(1);
	});

	it("returns an empty result when the repo has no capture dir", async () => {
		const res = await run(tempDir());
		expect(res).toEqual({
			resolved: { byReviewRow: 0, byTranscript: 0 },
			unresolved: 0,
			events: 0,
			file: null,
		});
	});
});
