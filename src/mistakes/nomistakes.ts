import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { gateRepoSlug } from "../gate/run.js";

export interface NoMistakesRun {
	id: string;
	branch: string;
	headSha: string;
}

export interface NoMistakesRound {
	stepName: string;
	stepStatus: string;
	stepFindingsJson: string | null;
	round: number | null;
	findingsJson: string | null;
	selectedFindingIds: string | null;
	selectionSource: string | null;
	reviewedHeadSha: string | null;
}

export interface NoMistakesSource {
	runs(repo: string): Promise<NoMistakesRun[]>;
	rounds(runId: string): Promise<NoMistakesRound[]>;
}

export interface Decision {
	findingId: string;
	status: "approved" | "skipped";
	step: string;
	note: "selected-for-fix" | "user_declined" | "auto-fix" | "step-skipped";
	atHead: string | null;
	path: string | null;
	title: string;
	severity: string;
}

export type SqliteExec = (
	file: string,
	args: readonly string[],
) => Promise<string>;

const RunRow = z.object({
	id: z.string(),
	branch: z.string(),
	head_sha: z.string(),
	upstream_url: z.string().nullable(),
	working_path: z.string(),
});

const RoundRow = z.object({
	step_name: z.string(),
	step_status: z.string(),
	step_findings_json: z.string().nullable(),
	round: z.number().nullable(),
	findings_json: z.string().nullable(),
	selected_finding_ids: z.string().nullable(),
	selection_source: z.string().nullable(),
	reviewed_head_sha: z.string().nullable(),
});

const Finding = z.object({
	id: z.string(),
	severity: z.string(),
	file: z.string().nullish(),
	description: z.string().default(""),
});

const RUNS_SQL = `SELECT r.id, r.branch, r.head_sha, p.upstream_url, p.working_path
FROM runs r JOIN repos p ON p.id = r.repo_id
ORDER BY r.created_at`;

const roundsSql = (
	runId: string,
) => `SELECT s.step_name, s.status AS step_status, s.findings_json AS step_findings_json,
r.round, r.findings_json, r.selected_finding_ids, r.selection_source, r.reviewed_head_sha
FROM step_results s LEFT JOIN step_rounds r ON r.step_result_id = s.id
WHERE s.run_id = '${runId}'
ORDER BY s.step_order, r.round`;

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const defaultExec: SqliteExec = async (file, args) =>
	(
		await promisify(execFile)(file, [...args], {
			encoding: "utf-8",
			maxBuffer: 256 * 1024 * 1024,
		})
	).stdout;

function parseRows<T>(
	output: string,
	schema: z.ZodType<T>,
	what: string,
	dbPath: string,
	warn: (msg: string) => void,
): T[] {
	if (!output.trim()) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(output);
	} catch (error) {
		throw new Error(
			`mistakes ingest: could not parse sqlite3 ${what} output from ${dbPath}`,
			{ cause: error },
		);
	}
	if (!Array.isArray(raw)) {
		throw new Error(
			`mistakes ingest: sqlite3 ${what} output from ${dbPath} was not a JSON array`,
		);
	}
	const rows = raw;
	const parsed = rows.map((r) => schema.safeParse(r));
	const skipped = parsed.filter((p) => !p.success).length;
	if (skipped > 0) {
		warn(
			`mistakes ingest: skipped ${skipped} unrecognized no-mistakes ${what} row(s)`,
		);
	}
	return parsed.flatMap((p) => (p.success ? [p.data] : []));
}

/** Reads no-mistakes runs and step rounds from its `state.sqlite` through the `sqlite3` CLI, opened read-only. */
export function sqliteNoMistakesSource(opts: {
	dbPath: string;
	exec?: SqliteExec;
	warn?: (msg: string) => void;
}): NoMistakesSource {
	const exec = opts.exec ?? defaultExec;
	const warn = opts.warn ?? ((msg: string) => console.error(msg));
	const query = (sql: string) =>
		exec("sqlite3", ["-readonly", "-json", opts.dbPath, sql]);
	return {
		async runs(repo) {
			const want = repo.toLowerCase();
			return parseRows(await query(RUNS_SQL), RunRow, "run", opts.dbPath, warn)
				.filter((r) => {
					const { owner, repo: name } = gateRepoSlug(
						r.upstream_url,
						r.working_path,
					);
					return `${owner}/${name}`.toLowerCase() === want;
				})
				.map((r) => ({
					id: r.id,
					branch: r.branch,
					headSha: r.head_sha,
				}));
		},
		async rounds(runId) {
			if (!SAFE_ID.test(runId))
				throw new Error(
					`mistakes ingest: refusing no-mistakes run id with unexpected characters: ${JSON.stringify(runId)}`,
				);
			return parseRows(
				await query(roundsSql(runId)),
				RoundRow,
				"round",
				opts.dbPath,
				warn,
			).map((r) => ({
				stepName: r.step_name,
				stepStatus: r.step_status,
				stepFindingsJson: r.step_findings_json,
				round: r.round,
				findingsJson: r.findings_json,
				selectedFindingIds: r.selected_finding_ids,
				selectionSource: r.selection_source,
				reviewedHeadSha: r.reviewed_head_sha,
			}));
		},
	};
}

function parseFindings(json: string | null): {
	findings: z.infer<typeof Finding>[];
	skipped: number;
} {
	if (json === null) return { findings: [], skipped: 0 };
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return { findings: [], skipped: 1 };
	}
	const list = (raw as { findings?: unknown } | null)?.findings;
	if (!Array.isArray(list)) return { findings: [], skipped: 1 };
	const parsed = list.map((f) => Finding.safeParse(f));
	return {
		findings: parsed.flatMap((p) => (p.success ? [p.data] : [])),
		skipped: parsed.filter((p) => !p.success).length,
	};
}

/** Parses a `selected_finding_ids` column into a set of ids. Returns `null` for invalid JSON, non-array JSON, or an array with a non-string entry — distinct from a genuinely empty `[]`, which is a valid, deliberate selection. */
function parseIds(json: string | null): Set<string> | null {
	if (json === null) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string"))
		return null;
	return new Set(raw);
}

/** Maps a no-mistakes run's rounds to per-finding decisions: a finding chosen for fixing is `approved`, one declined by the user or in a skipped step is `skipped`. Unrecognized finding shapes are counted in `skipped`, never thrown. */
export function decisionsFor(
	run: NoMistakesRun,
	rounds: readonly NoMistakesRound[],
): { decisions: Decision[]; skipped: number } {
	const decisions: Decision[] = [];
	let skipped = 0;
	const skippedSteps = new Set<string>();
	const lastRoundHead = (stepName: string): string => {
		const last = rounds
			.filter((r) => r.stepName === stepName && r.round !== null)
			.at(-1);
		return last?.reviewedHeadSha ?? run.headSha;
	};
	const add = (
		findings: z.infer<typeof Finding>[],
		status: Decision["status"],
		note: Decision["note"],
		atHead: string | null,
		step: string,
	) => {
		for (const f of findings) {
			decisions.push({
				findingId: f.id,
				status,
				step,
				note,
				atHead,
				path: f.file ?? null,
				title: f.description.split("\n")[0] ?? "",
				severity: f.severity,
			});
		}
	};
	for (const r of rounds) {
		if (r.stepStatus === "skipped" && !skippedSteps.has(r.stepName)) {
			skippedSteps.add(r.stepName);
			const step = parseFindings(r.stepFindingsJson);
			skipped += step.skipped;
			add(
				step.findings,
				"skipped",
				"step-skipped",
				lastRoundHead(r.stepName),
				r.stepName,
			);
		}
		if (r.round === null) continue;
		const round = parseFindings(r.findingsJson);
		skipped += round.skipped;
		const selected = parseIds(r.selectedFindingIds);
		if (selected === null) {
			if (r.selectionSource !== null) skipped++;
			continue;
		}
		const chosen = round.findings.filter((f) => selected.has(f.id));
		const head = r.reviewedHeadSha;
		if (r.selectionSource === "user") {
			add(chosen, "approved", "selected-for-fix", head, r.stepName);
		} else if (r.selectionSource === "auto_fix") {
			add(chosen, "approved", "auto-fix", head, r.stepName);
		} else if (r.selectionSource === "user_declined") {
			const declined = round.findings.filter((f) => !selected.has(f.id));
			add(declined, "skipped", "user_declined", head, r.stepName);
		}
	}
	return { decisions, skipped };
}
