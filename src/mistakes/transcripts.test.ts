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
		expect(res).toEqual({ sessions: [], skipped: 0 });
	});
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
