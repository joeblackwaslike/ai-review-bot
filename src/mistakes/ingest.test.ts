import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingest } from "./ingest.js";
import { fileStamp, openMistakeLog } from "./log.js";
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

	it("reads the same sanitized directory capture wrote for a repo needing sanitizing", async () => {
		const root = tempDir();
		const log = openMistakeLog({
			root,
			owner: "o",
			repo: "weird repo",
			source: "gate",
			branch: "feat/x",
			now: () => new Date("2026-11-01T12:00:00.000Z"),
		});
		log.append({
			type: "run",
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
			implementer: NONE,
		});

		const res = await run(root, { repo: "o/weird repo" });

		expect(res.resolved).toEqual({ byReviewRow: 0, byTranscript: 0 });
		expect(res.unresolved).toBe(1);
		expect(res.file).toBeNull();
	});

	it("falls back to the transcript scan with medium confidence", async () => {
		const root = tempDir();
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const gateId = capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
		});

		const res = await run(root, { transcriptsDir: TRANSCRIPTS });

		expect(res.resolved).toEqual({ byReviewRow: 0, byTranscript: 1 });
		expect(warn).toHaveBeenCalledWith(
			"mistakes ingest: skipped 1 malformed transcript line(s)",
		);
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
		vi.spyOn(console, "error").mockImplementation(() => {});
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
				{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa" },
				{ id: "NMRUN2", branch: "feat/x", headSha: "zzzz" },
				{ id: "NMRUN3", branch: "feat/y", headSha: "aaaa" },
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
				step: "gate.review.ai-review",
				atHead: "aaaa",
				fixCommit: null,
				path: "src/a.ts",
				title: "Bug",
				severity: "error",
				note: "selected-for-fix",
			},
		]);
	});

	it("persists the run head as atHead when the round has no reviewed head", async () => {
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
				[{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa" }],
				{ NMRUN1: [{ ...DECIDED_ROUND, reviewedHeadSha: null }] },
			),
		});
		expect(res.events).toBe(1);
		expect(readOutput(res.file)).toMatchObject([{ atHead: "aaaa" }]);
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
				[{ id: "NMRUN1", branch: "feat/x", headSha: "0000" }],
				{ NMRUN1: [DECIDED_ROUND] },
			),
		});
		expect(res.events).toBe(1);
	});

	it("drops decisions at heads not captured even when the run matches", async () => {
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
				[{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa" }],
				{
					NMRUN1: [
						DECIDED_ROUND,
						{
							...DECIDED_ROUND,
							round: 2,
							findingsJson: JSON.stringify({
								findings: [
									{
										id: "f2",
										severity: "error",
										file: "src/b.ts",
										description: "Other bug",
									},
								],
							}),
							selectedFindingIds: '["f2"]',
							reviewedHeadSha: "bbbb",
						},
					],
				},
			),
		});
		expect(res.events).toBe(1);
		const findingIds = readOutput(res.file).map((l) =>
			l.type === "event" ? l.findingId : null,
		);
		expect(findingIds).toEqual(["f1"]);
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
		const badFile = join(dir, "2026-11-01T00-00-00-000Z-bad.jsonl");
		writeFileSync(badFile, "{oops\n");
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
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await run(root, {
			transcriptsDir: TRANSCRIPTS,
			noMistakes: fakeNoMistakes(
				[{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa" }],
				{ NMRUN1: [DECIDED_ROUND] },
			),
		});

		expect(hashes()).toEqual(before);
		expect(error).toHaveBeenCalledWith(expect.stringContaining(badFile));
		expect(error).toHaveBeenCalledWith(expect.stringContaining(":1"));
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
			fakeNoMistakes([{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa" }], {
				NMRUN1: [DECIDED_ROUND],
			});

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

	it("keeps decisions that differ only by step and dedupes each on re-run", async () => {
		const root = tempDir();
		capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
			implementer: claude("s-env"),
		});
		const nm = () =>
			fakeNoMistakes([{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa" }], {
				NMRUN1: [DECIDED_ROUND, { ...DECIDED_ROUND, stepName: "review" }],
			});

		const first = await run(root, { noMistakes: nm() });
		const second = await run(root, { noMistakes: nm() });

		expect(first.events).toBe(2);
		expect(
			readOutput(first.file).map((r) => r.type === "event" && r.step),
		).toEqual(["gate.review.ai-review", "review"]);
		expect(second.events).toBe(0);
	});

	it("keeps identical decisions from different no-mistakes runs at the same head", async () => {
		const root = tempDir();
		capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
			implementer: claude("s-env"),
		});
		const nm = () =>
			fakeNoMistakes(
				[
					{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa" },
					{ id: "NMRUN2", branch: "feat/x", headSha: "aaaa" },
				],
				{ NMRUN1: [DECIDED_ROUND], NMRUN2: [DECIDED_ROUND] },
			);

		const first = await run(root, { noMistakes: nm() });
		const second = await run(root, { noMistakes: nm() });

		expect(first.events).toBe(2);
		expect(readOutput(first.file).map((r) => r.runId)).toEqual([
			"NMRUN1",
			"NMRUN2",
		]);
		expect(second.events).toBe(0);
	});

	it.skipIf(process.platform === "win32")(
		"writes the ingest file and directory without group or other access",
		async () => {
			const root = tempDir();
			capture(root, {
				source: "gate",
				branch: "feat/x",
				at: "2026-11-01T12:00:00.000Z",
				implementer: claude("s-env"),
			});
			const res = await run(root, {
				noMistakes: fakeNoMistakes(
					[{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa" }],
					{ NMRUN1: [DECIDED_ROUND] },
				),
			});
			expect(statSync(res.file as string).mode & 0o077).toBe(0);
		},
	);

	it("retries with a numbered suffix when the ingest file name is taken", async () => {
		const root = tempDir();
		capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
			implementer: claude("s-env"),
		});
		const now = new Date("2026-11-02T00:00:00.000Z");
		const dir = join(root, `${OWNER}__${REPO}`);
		const taken = `ingest-${fileStamp(now)}`;
		writeFileSync(join(dir, `${taken}.jsonl`), "");
		writeFileSync(join(dir, `${taken}-2.jsonl`), "");

		const res = await run(root, {
			now: () => now,
			noMistakes: fakeNoMistakes(
				[{ id: "NMRUN1", branch: "feat/x", headSha: "aaaa" }],
				{ NMRUN1: [DECIDED_ROUND] },
			),
		});

		expect(res.file).toBe(join(dir, `${taken}-3.jsonl`));
		expect(readOutput(res.file)).toHaveLength(1);
	});

	it("preserves the review's implementer agent when resolving a gate run", async () => {
		const root = tempDir();
		const codex: Implementer = {
			agent: "codex",
			sessionId: "s-codex",
			source: "env",
			confidence: "high",
		};
		capture(root, {
			source: "review",
			branch: "feat/x",
			at: "2026-11-01T10:00:00.000Z",
			implementer: codex,
		});
		const gateId = capture(root, {
			source: "gate",
			branch: "feat/x",
			at: "2026-11-01T12:00:00.000Z",
		});

		const res = await run(root);

		const [ann] = readOutput(res.file);
		expect(ann).toMatchObject({
			type: "annotation",
			runId: gateId,
			implementer: {
				agent: "codex",
				sessionId: "s-codex",
				source: "resolved",
				confidence: "high",
			},
		});
	});

	it("produces one annotation and one resolved count for two gate run records sharing a runId", async () => {
		const root = tempDir();
		capture(root, {
			source: "review",
			branch: "feat/x",
			at: "2026-11-01T10:00:00.000Z",
			implementer: claude("s1"),
		});
		const log = openMistakeLog({
			root,
			owner: OWNER,
			repo: REPO,
			source: "gate",
			branch: "feat/x",
			now: () => new Date("2026-11-01T12:00:00.000Z"),
		});
		const appendRound = (round: number) =>
			log.append({
				type: "run",
				headSha: "aaaa",
				mergeBase: null,
				scope: "range",
				round,
				costUsd: 0,
				durationSeconds: 1,
				providers: [],
				models: [],
				agentsAttempted: 0,
				agentsSucceeded: 0,
				partial: false,
				reportPath: null,
				implementer: NONE,
			});
		appendRound(1);
		appendRound(2);

		const res = await run(root);

		expect(res.resolved).toEqual({ byReviewRow: 1, byTranscript: 0 });
		expect(
			readOutput(res.file).filter((r) => r.type === "annotation"),
		).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")(
		"warns and skips an unreadable capture file instead of aborting",
		async () => {
			const root = tempDir();
			const gateId = capture(root, {
				source: "gate",
				branch: "feat/x",
				at: "2026-11-01T12:00:00.000Z",
				implementer: claude("s-env"),
			});
			const dir = join(root, `${OWNER}__${REPO}`);
			const badFile = join(dir, "2026-11-01T00-00-00-000Z-unreadable.jsonl");
			writeFileSync(badFile, '{"type":"run"}\n');
			chmodSync(badFile, 0o000);
			const warn = vi.spyOn(console, "error").mockImplementation(() => {});

			try {
				const res = await run(root);
				expect(warn).toHaveBeenCalledWith(expect.stringContaining(badFile));
				expect(res).toEqual({
					resolved: { byReviewRow: 0, byTranscript: 0 },
					unresolved: 0,
					events: 0,
					file: null,
				});
			} finally {
				chmodSync(badFile, 0o600);
			}
			expect(gateId).toBeTruthy();
		},
	);

	it.skipIf(process.platform === "win32")(
		"aborts instead of reporting a partial result when an existing ingest file is unreadable",
		async () => {
			const root = tempDir();
			capture(root, {
				source: "gate",
				branch: "feat/x",
				at: "2026-11-01T12:00:00.000Z",
				implementer: claude("s-env"),
			});
			const dir = join(root, `${OWNER}__${REPO}`);
			const badIngestFile = join(dir, "ingest-2026-11-01T00-00-00-000Z.jsonl");
			writeFileSync(badIngestFile, '{"type":"annotation"}\n');
			chmodSync(badIngestFile, 0o000);
			vi.spyOn(console, "error").mockImplementation(() => {});

			try {
				await expect(run(root)).rejects.toThrow(badIngestFile);
			} finally {
				chmodSync(badIngestFile, 0o600);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"aborts instead of reporting an empty result when the capture dir cannot be listed",
		async () => {
			const root = tempDir();
			const dir = join(root, `${OWNER}__${REPO}`);
			mkdirSync(dir, { recursive: true });
			chmodSync(dir, 0o000);
			vi.spyOn(console, "error").mockImplementation(() => {});

			try {
				await expect(run(root)).rejects.toThrow(dir);
			} finally {
				chmodSync(dir, 0o700);
			}
		},
	);

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
