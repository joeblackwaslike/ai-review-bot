import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	decisionsFor,
	type NoMistakesRound,
	type NoMistakesRun,
	type SqliteExec,
	sqliteNoMistakesSource,
} from "./nomistakes.js";

const hasSqlite3 = (() => {
	try {
		execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const fixture = (name: string) =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");

function source(output: string) {
	const exec = vi.fn<SqliteExec>(async () => output);
	const warn = vi.fn();
	return {
		exec,
		warn,
		src: sqliteNoMistakesSource({ dbPath: "/db/state.sqlite", exec, warn }),
	};
}

describe("sqliteNoMistakesSource", () => {
	it("runs sqlite3 read-only with json output and keeps runs for the repo", async () => {
		const { exec, warn, src } = source(fixture("nomistakes-runs.json"));
		const runs = await src.runs("o/r");
		expect(exec).toHaveBeenCalledTimes(1);
		const [file, args] = exec.mock.calls[0] ?? [];
		expect(file).toBe("sqlite3");
		expect(args?.slice(0, 3)).toEqual([
			"-readonly",
			"-json",
			"/db/state.sqlite",
		]);
		expect(args).toHaveLength(4);
		expect(args?.[3]).toContain("FROM runs");
		expect(args?.[3]).toContain("JOIN repos");
		expect(runs).toEqual([
			{
				id: "01RUNMATCH0000000000000000",
				branch: "feat/x",
				headSha: "aaaa",
			},
		]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("skipped 1 unrecognized no-mistakes run row"),
		);
	});

	it("selects step results and their rounds for one run", async () => {
		const { exec, src } = source(fixture("nomistakes-rounds.json"));
		const rounds = await src.rounds("01RUNMATCH0000000000000000");
		const sql = exec.mock.calls[0]?.[1]?.[3] ?? "";
		expect(exec.mock.calls[0]?.[1]?.slice(0, 3)).toEqual([
			"-readonly",
			"-json",
			"/db/state.sqlite",
		]);
		expect(sql).toContain("FROM step_results");
		expect(sql).toContain("LEFT JOIN step_rounds");
		expect(sql).toContain("step_result_id");
		expect(sql).toContain("'01RUNMATCH0000000000000000'");
		expect(rounds).toHaveLength(5);
		expect(rounds[0]).toMatchObject({
			stepName: "gate.review.ai-review",
			stepStatus: "completed",
			round: 1,
			selectionSource: "user",
			reviewedHeadSha: "aaaa",
		});
	});

	it("treats empty sqlite3 output as no rows", async () => {
		const { src } = source("");
		expect(await src.runs("o/r")).toEqual([]);
		expect(await src.rounds("01RUN")).toEqual([]);
	});

	it("names the label and db path when sqlite3 output is not JSON", async () => {
		const { src } = source("not json");
		await expect(src.runs("o/r")).rejects.toThrow(/run.*\/db\/state\.sqlite/s);
		await expect(src.runs("o/r")).rejects.toMatchObject({
			cause: expect.any(SyntaxError),
		});
	});

	it("names the label and db path when sqlite3 output is valid JSON but not an array", async () => {
		const { src } = source("null");
		await expect(src.runs("o/r")).rejects.toThrow(/run.*\/db\/state\.sqlite/s);
		const { src: src2 } = source('{"error":"unexpected response"}');
		await expect(src2.rounds("01RUN")).rejects.toThrow(
			/round.*\/db\/state\.sqlite/s,
		);
	});

	it("refuses a run id that is not a plain identifier", async () => {
		const { exec, src } = source("[]");
		await expect(src.rounds("x'; DROP TABLE runs; --")).rejects.toThrow(
			/refusing no-mistakes run id with unexpected characters/,
		);
		expect(exec).not.toHaveBeenCalled();
	});
});

describe("decisionsFor", () => {
	const run: NoMistakesRun = {
		id: "01RUNMATCH0000000000000000",
		branch: "feat/x",
		headSha: "aaaa",
	};

	async function rounds(): Promise<NoMistakesRound[]> {
		return source(fixture("nomistakes-rounds.json")).src.rounds(run.id);
	}

	it("maps selections, declines, auto-fix and skipped steps to decisions", async () => {
		const { decisions, skipped } = decisionsFor(run, await rounds());
		expect(decisions).toEqual([
			{
				findingId: "f1",
				step: "gate.review.ai-review",
				status: "approved",
				note: "selected-for-fix",
				atHead: "aaaa",
				path: "src/a.ts",
				title: "Null deref",
				severity: "error",
			},
			{
				findingId: "r1",
				step: "review",
				status: "skipped",
				note: "user_declined",
				atHead: "aaaa",
				path: null,
				title: "Nit",
				severity: "info",
			},
			{
				findingId: "r2",
				step: "review",
				status: "approved",
				note: "auto-fix",
				atHead: "cccc",
				path: "src/c.ts",
				title: "Race",
				severity: "error",
			},
			{
				findingId: "t1",
				step: "test",
				status: "skipped",
				note: "step-skipped",
				atHead: "aaaa",
				path: null,
				title: "Flaky",
				severity: "warning",
			},
		]);
		expect(skipped).toBe(3);
	});

	it("dates a skipped step's findings at its last round head, else the run head", () => {
		const base: NoMistakesRound = {
			stepName: "test",
			stepStatus: "skipped",
			stepFindingsJson: JSON.stringify({
				findings: [{ id: "t1", severity: "warning", description: "Flaky" }],
			}),
			round: null,
			findingsJson: null,
			selectedFindingIds: null,
			selectionSource: null,
			reviewedHeadSha: null,
		};
		const withRounds = decisionsFor(run, [
			{ ...base, round: 1, reviewedHeadSha: "bbbb" },
			{ ...base, round: 2, reviewedHeadSha: "dddd" },
		]);
		expect(withRounds.decisions.map((d) => d.atHead)).toEqual(["dddd"]);
		const noRounds = decisionsFor(run, [base]);
		expect(noRounds.decisions.map((d) => d.atHead)).toEqual(["aaaa"]);
	});

	it("skips decision generation for a round with corrupt selection data instead of declining everything", () => {
		const round: NoMistakesRound = {
			stepName: "gate.review.ai-review",
			stepStatus: "completed",
			stepFindingsJson: null,
			round: 1,
			findingsJson: JSON.stringify({
				findings: [{ id: "f1", severity: "error", description: "Bug" }],
			}),
			selectedFindingIds: "[",
			selectionSource: "user_declined",
			reviewedHeadSha: "aaaa",
		};
		const { decisions, skipped } = decisionsFor(run, [round]);
		expect(decisions).toEqual([]);
		expect(skipped).toBe(1);
	});

	it("skips decision generation for a round with missing selectedFindingIds", () => {
		const round: NoMistakesRound = {
			stepName: "gate.review.ai-review",
			stepStatus: "completed",
			stepFindingsJson: null,
			round: 1,
			findingsJson: JSON.stringify({
				findings: [{ id: "f1", severity: "error", description: "Bug" }],
			}),
			selectedFindingIds: null,
			selectionSource: "user_declined",
			reviewedHeadSha: "aaaa",
		};
		const { decisions, skipped } = decisionsFor(run, [round]);
		expect(decisions).toEqual([]);
		expect(skipped).toBe(1);
	});

	it("does not count a round nobody has decided yet as unrecognized", () => {
		const round: NoMistakesRound = {
			stepName: "gate.review.ai-review",
			stepStatus: "completed",
			stepFindingsJson: null,
			round: 1,
			findingsJson: JSON.stringify({
				findings: [{ id: "f1", severity: "error", description: "Bug" }],
			}),
			selectedFindingIds: null,
			selectionSource: null,
			reviewedHeadSha: "aaaa",
		};
		expect(decisionsFor(run, [round])).toEqual({ decisions: [], skipped: 0 });
	});

	it("keeps a genuinely empty selection distinct from corrupt data", () => {
		const round: NoMistakesRound = {
			stepName: "gate.review.ai-review",
			stepStatus: "completed",
			stepFindingsJson: null,
			round: 1,
			findingsJson: JSON.stringify({
				findings: [{ id: "f1", severity: "error", description: "Bug" }],
			}),
			selectedFindingIds: "[]",
			selectionSource: "user_declined",
			reviewedHeadSha: "aaaa",
		};
		const { decisions, skipped } = decisionsFor(run, [round]);
		expect(decisions).toEqual([
			{
				findingId: "f1",
				step: "gate.review.ai-review",
				status: "skipped",
				note: "user_declined",
				atHead: "aaaa",
				path: null,
				title: "Bug",
				severity: "error",
			},
		]);
		expect(skipped).toBe(0);
	});
});

describe.skipIf(!hasSqlite3)(
	"sqliteNoMistakesSource against a real sqlite3 database",
	() => {
		it("reads runs and decisions through the production schema", async () => {
			const dir = mkdtempSync(join(tmpdir(), "nomistakes-sqlite-"));
			const dbPath = join(dir, "state.sqlite");
			try {
				execFileSync(
					"sqlite3",
					[
						dbPath,
						`
CREATE TABLE repos (id TEXT PRIMARY KEY, working_path TEXT NOT NULL UNIQUE, upstream_url TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id), branch TEXT NOT NULL, head_sha TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE step_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step_name TEXT NOT NULL, step_order INTEGER NOT NULL, status TEXT NOT NULL, findings_json TEXT);
CREATE TABLE step_rounds (id TEXT PRIMARY KEY, step_result_id TEXT NOT NULL REFERENCES step_results(id), round INTEGER NOT NULL, findings_json TEXT, reviewed_head_sha TEXT, selected_finding_ids TEXT, selection_source TEXT, created_at INTEGER NOT NULL);

INSERT INTO repos VALUES ('repo1', '/work/match', 'https://github.com/o/r.git', 1000);
INSERT INTO repos VALUES ('repo2', '/work/other', 'https://github.com/o/other.git', 1000);

INSERT INTO runs VALUES ('run1', 'repo1', 'feat/x', 'aaaa', 2000);
INSERT INTO runs VALUES ('run2', 'repo2', 'feat/y', 'bbbb', 2000);

INSERT INTO step_results VALUES ('step1', 'run1', 'gate.review.ai-review', 1, 'completed', NULL);

INSERT INTO step_rounds VALUES ('round1', 'step1', 1, '{"findings":[{"id":"f1","severity":"error","file":"src/a.ts","description":"Bug"}]}', 'aaaa', '["f1"]', 'user', 3000);
`,
					],
					{ encoding: "utf-8" },
				);

				const src = sqliteNoMistakesSource({ dbPath });
				const runs = await src.runs("o/r");
				expect(runs).toEqual([
					{ id: "run1", branch: "feat/x", headSha: "aaaa" },
				]);

				const rounds = await src.rounds("run1");
				const { decisions } = decisionsFor(runs[0] as NoMistakesRun, rounds);
				expect(decisions).toEqual([
					{
						findingId: "f1",
						step: "gate.review.ai-review",
						status: "approved",
						note: "selected-for-fix",
						atHead: "aaaa",
						path: "src/a.ts",
						title: "Bug",
						severity: "error",
					},
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	},
);
