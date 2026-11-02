import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	pickSession,
	type SessionActivity,
	scanTranscripts,
} from "./transcripts.js";

const DIR = fileURLToPath(new URL("./fixtures/transcripts", import.meta.url));
const t = (iso: string) => Date.parse(iso);
const RUN = t("2026-11-01T12:00:00.000Z");

describe("scanTranscripts", () => {
	it("collects per-session activity on the branch from matching project dirs only", async () => {
		const { sessions, skipped } = await scanTranscripts({
			dir: DIR,
			repoName: "ai-review-bot",
			branch: "feat/x",
		});
		const ids = sessions.map((s) => s.sessionId).sort();
		expect(ids).toEqual(["sess-commit", "sess-late", "sess-plain"]);
		expect(skipped).toBe(1);
	});

	it("does not count a malformed line that cannot mention the branch", async () => {
		const { skipped } = await scanTranscripts({
			dir: DIR,
			repoName: "ai-review-bot",
			branch: "feat/never",
		});
		expect(skipped).toBe(0);
	});

	it("merges duplicate session ids from several files into one candidate", async () => {
		const { sessions } = await scanTranscripts({
			dir: DIR,
			repoName: "ai-review-bot",
			branch: "feat/x",
		});
		const plain = sessions.filter((s) => s.sessionId === "sess-plain");
		expect(plain).toHaveLength(1);
		expect(plain[0]?.times).toHaveLength(3);
	});

	it("keeps only lines on the branch and records git commit/push times", async () => {
		const { sessions } = await scanTranscripts({
			dir: DIR,
			repoName: "ai-review-bot",
			branch: "feat/x",
		});
		const commit = sessions.find((s) => s.sessionId === "sess-commit");
		expect(commit?.times).toEqual([
			t("2026-11-01T10:00:00.000Z"),
			t("2026-11-01T10:30:00.000Z"),
			t("2026-11-01T11:00:00.000Z"),
		]);
		expect(commit?.commitTimes).toEqual([t("2026-11-01T10:30:00.000Z")]);
		const plain = sessions.find((s) => s.sessionId === "sess-plain");
		expect(plain?.commitTimes).toEqual([]);
	});

	it("returns nothing when the transcripts dir does not exist", async () => {
		const res = await scanTranscripts({
			dir: `${DIR}/missing`,
			repoName: "ai-review-bot",
			branch: "feat/x",
		});
		expect(res).toEqual({ sessions: [], skipped: 0, warnings: [] });
	});

	it("does not match a project dir by bare substring, so a similarly-named repo is excluded", async () => {
		const root = await mkdtemp(join(tmpdir(), "transcripts-"));
		mkdirSync(join(root, "-Users-x-ai-review-bot"), { recursive: true });
		writeFileSync(
			join(root, "-Users-x-ai-review-bot", "sess-real.jsonl"),
			`${JSON.stringify({ sessionId: "sess-real", gitBranch: "feat/x", timestamp: "2026-11-01T10:00:00.000Z" })}\n`,
		);
		mkdirSync(join(root, "-Users-x-ai-review-bot-demo"), { recursive: true });
		writeFileSync(
			join(root, "-Users-x-ai-review-bot-demo", "sess-demo.jsonl"),
			`${JSON.stringify({ sessionId: "sess-demo", gitBranch: "feat/x", timestamp: "2026-11-01T10:00:00.000Z" })}\n`,
		);

		const { sessions } = await scanTranscripts({
			dir: root,
			repoName: "ai-review-bot",
			branch: "feat/x",
		});

		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-real"]);
	});

	it.skipIf(process.platform === "win32")(
		"warns with the directory path on a non-ENOENT listing failure",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "transcripts-"));
			chmodSync(root, 0o000);
			try {
				const { sessions, warnings } = await scanTranscripts({
					dir: root,
					repoName: "ai-review-bot",
					branch: "feat/x",
				});
				expect(sessions).toEqual([]);
				expect(warnings).toEqual([expect.stringContaining(root)]);
			} finally {
				chmodSync(root, 0o700);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"warns and continues when a transcript file cannot be read",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "transcripts-"));
			const project = join(root, "-Users-x-ai-review-bot");
			mkdirSync(project, { recursive: true });
			const good = join(project, "sess-good.jsonl");
			const bad = join(project, "sess-bad.jsonl");
			writeFileSync(
				good,
				`${JSON.stringify({ sessionId: "sess-good", gitBranch: "feat/x", timestamp: "2026-11-01T10:00:00.000Z" })}\n`,
			);
			writeFileSync(bad, "unreadable\n");
			chmodSync(bad, 0o000);
			try {
				const { sessions, warnings } = await scanTranscripts({
					dir: root,
					repoName: "ai-review-bot",
					branch: "feat/x",
				});
				expect(sessions.map((s) => s.sessionId)).toEqual(["sess-good"]);
				expect(warnings).toEqual([expect.stringContaining(bad)]);
			} finally {
				chmodSync(bad, 0o600);
			}
		},
	);
});

describe("pickSession", () => {
	const s = (
		sessionId: string,
		times: string[],
		commits: string[] = [],
	): SessionActivity => ({
		sessionId,
		times: times.map(t),
		commitTimes: commits.map(t),
	});

	it("prefers a session with a commit in the window over a later plain one", () => {
		const pick = pickSession(
			[
				s(
					"a",
					["2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z"],
					["2026-11-01T10:30:00Z"],
				),
				s("b", ["2026-11-01T09:00:00Z", "2026-11-01T11:30:00Z"]),
			],
			RUN,
		);
		expect(pick).toEqual({ sessionId: "a", confidence: "medium" });
	});

	it("ignores sessions that start after the run and commits after the run", () => {
		const pick = pickSession(
			[
				s("late", ["2026-11-01T13:00:00Z"], ["2026-11-01T13:00:00Z"]),
				s(
					"after",
					["2026-11-01T11:00:00Z", "2026-11-01T12:30:00Z"],
					["2026-11-01T12:30:00Z"],
				),
			],
			RUN,
		);
		expect(pick).toEqual({ sessionId: "after", confidence: "medium" });
	});

	it("returns the latest active session with low confidence when the top tier ties", () => {
		const pick = pickSession(
			[
				s("x", ["2026-11-01T10:00:00Z"], ["2026-11-01T10:00:00Z"]),
				s(
					"y",
					["2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z"],
					["2026-11-01T10:30:00Z"],
				),
			],
			RUN,
		);
		expect(pick).toEqual({ sessionId: "y", confidence: "low" });
	});

	it("does not count activity more than 6 hours after the run", () => {
		const pick = pickSession(
			[
				s("x", ["2026-11-01T10:00:00Z", "2026-11-02T03:00:00Z"]),
				s("y", ["2026-11-01T10:00:00Z", "2026-11-01T17:00:00Z"]),
			],
			RUN,
		);
		expect(pick).toEqual({ sessionId: "y", confidence: "low" });
	});

	it("returns null without candidates", () => {
		expect(pickSession([], RUN)).toBeNull();
		expect(pickSession([s("late", ["2026-11-01T13:00:00Z"])], RUN)).toBeNull();
	});
});
