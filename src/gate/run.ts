import { writeFile } from "node:fs/promises";
import { type ReviewPassResult, runReviewPasses } from "../audit.js";
import { isSettled, type LedgerEntry } from "../ledger/types.js";
import type { ModelReview } from "../review.js";
import {
	type AuditFile,
	collectFilesFromRange,
	defaultGitRunner,
	diffHash,
	type GitRunner,
	listRangeChanges,
	resolveBase,
} from "../sources.js";
import {
	capFindings,
	formatReport,
	type GateFinding,
	toGateFinding,
	validateReport,
} from "./report.js";
import { applyRound } from "./round.js";
import { gateStorePath, loadStore, saveStore, storeKey } from "./store.js";

export type GateOptions = {
	cwd: string;
	owner: string;
	repo: string;
	base?: string;
	extra?: string;
	findingsFile?: string;
	storeDir?: string;
	runGit?: GitRunner;
	review?: (files: AuditFile[]) => Promise<ReviewPassResult>;
};

export type GateResult = {
	exitCode: 0 | 1;
	stdout: string;
	findings: GateFinding[];
};

const EMPTY_REVIEW: ModelReview = {
	event: "COMMENT",
	general_findings: [],
	inline_comments: [],
};

const storedDiff = (e: LedgerEntry) =>
	e.evidence.find((s) => s.startsWith("diff:"))?.slice("diff:".length);

function isAncestor(runGit: GitRunner, sha: string): boolean {
	try {
		runGit(["merge-base", "--is-ancestor", sha, "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

/** Paths to re-review on a delta round: any path without an open entry, or whose open entries saw a different diff. */
function deltaPaths(
	hashes: ReadonlyMap<string, string>,
	renames: ReadonlyMap<string, string>,
	entries: readonly LedgerEntry[],
): Set<string> {
	const open = entries.filter((e) => !isSettled(e) && e.path !== null);
	const only = new Set<string>();
	for (const [path, hash] of hashes) {
		const onPath = open.filter(
			(e) => e.path === path || renames.get(e.path ?? "") === path,
		);
		if (onPath.length === 0 || onPath.some((e) => storedDiff(e) !== hash)) {
			only.add(path);
		}
	}
	return only;
}

function formatText(findings: readonly GateFinding[]): string {
	if (findings.length === 0) return "ai-review gate: no findings.";
	const lines = findings.map((f) => {
		const where = f.file
			? ` ${f.file}${f.line === undefined ? "" : `:${f.line}`}`
			: "";
		const [title, ...rest] = f.description.split("\n");
		const body = rest.join("\n").trim();
		return `[${f.severity}] ${f.id}${where}\n  ${title}${body ? `\n  ${body.replaceAll("\n", "\n  ")}` : ""}`;
	});
	return `ai-review gate: ${findings.length} finding(s)\n\n${lines.join("\n\n")}`;
}

/** One gate round over the branch's range: review what changed since the last round, update the store, and write or print the report. */
export async function runGate(opts: GateOptions): Promise<GateResult> {
	const runGit = opts.runGit ?? defaultGitRunner(opts.cwd);
	const review =
		opts.review ??
		((files: AuditFile[]) =>
			runReviewPasses({
				files,
				meta: { owner: opts.owner, repo: opts.repo, ref: "range" },
				extraInstructions: opts.extra,
			}));

	const base = resolveBase(runGit, opts.base);
	const { mergeBase, changes } = listRangeChanges(runGit, base);
	const head = runGit(["rev-parse", "HEAD"]).trim();
	const storePath = gateStorePath(
		storeKey(runGit, opts.owner, opts.repo, mergeBase),
		opts.storeDir,
	);
	const { store, warning } = await loadStore(storePath);
	if (warning) console.error(warning);

	const surviving = changes.filter((c) => c.status !== "D");
	const hashes = new Map(
		surviving.map((c) => [c.path, diffHash(runGit, mergeBase, c.path)]),
	);
	const renames = new Map(
		changes.flatMap((c) =>
			c.status === "R" && c.oldPath ? [[c.oldPath, c.path] as const] : [],
		),
	);

	const fullRescope =
		store.lastHead !== null && !isAncestor(runGit, store.lastHead);
	const only =
		store.lastHead === null || fullRescope
			? undefined
			: deltaPaths(hashes, renames, store.entries);
	const files = await collectFilesFromRange({
		cwd: opts.cwd,
		changes,
		only,
		runGit,
	});
	const pass = files.length === 0 ? null : await review(files);

	const round = Math.max(0, ...store.entries.map((e) => e.round)) + 1;
	const result = applyRound({
		merged: pass?.merged ?? EMPTY_REVIEW,
		store,
		head,
		round,
		hashes,
		renames,
		reviewedPaths: only ?? "all",
		complete: pass === null || pass.agentsSucceeded === pass.agentsAttempted,
		providers: pass?.providersRun ?? store.providers,
		fullRescope,
	});
	for (const w of result.warnings) console.error(w);

	await saveStore(storePath, result.store).catch((err: unknown) => {
		console.error(
			`Could not save gate history to ${storePath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	});

	const suggestions = new Map(
		result.emitted.map(({ entry, suggestion }) => [entry.id, suggestion]),
	);
	const open = result.store.entries.filter(
		(e) => !isSettled(e) && (e.path !== null || suggestions.has(e.id)),
	);
	const { kept, dropped } = capFindings(
		open.map((e) => toGateFinding(e, suggestions.get(e.id))),
	);
	if (dropped > 0) {
		console.error(`Dropped ${dropped} finding(s) over the 500-finding cap.`);
	}
	const json = formatReport(kept);
	const problems = validateReport(json);
	if (problems.length > 0) {
		throw new Error(`Gate report failed validation: ${problems.join("; ")}`);
	}

	if (opts.findingsFile) {
		await writeFile(opts.findingsFile, json);
		return {
			exitCode: 0,
			stdout: `ai-review gate: ${kept.length} finding(s) written to ${opts.findingsFile}`,
			findings: kept,
		};
	}
	return {
		exitCode: kept.some((f) => f.severity === "error") ? 1 : 0,
		stdout: formatText(kept),
		findings: kept,
	};
}
