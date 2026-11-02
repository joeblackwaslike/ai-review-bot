import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	decisionsFor,
	type NoMistakesRound,
	type NoMistakesRun,
	type SqliteExec,
	sqliteNoMistakesSource,
} from "./nomistakes.js";

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
				createdAt: 1793534400,
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

	it("refuses a run id that is not a plain identifier", async () => {
		const { exec, src } = source("[]");
		expect(await src.rounds("x'; DROP TABLE runs; --")).toEqual([]);
		expect(exec).not.toHaveBeenCalled();
	});
});

describe("decisionsFor", () => {
	const run: NoMistakesRun = {
		id: "01RUNMATCH0000000000000000",
		branch: "feat/x",
		headSha: "aaaa",
		createdAt: 1793534400,
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
		expect(skipped).toBe(2);
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
});
