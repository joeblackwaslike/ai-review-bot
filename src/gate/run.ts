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

/** Paths changed between `lastHead` and HEAD (new path for a rename), and the renames themselves. */
function changesSince(
	runGit: GitRunner,
	lastHead: string,
): { paths: string[]; renames: Map<string, string> } {
	const out = runGit([
		"-c",
		"core.quotePath=false",
		"diff",
		"-M",
		"--name-status",
		lastHead,
		"HEAD",
	]);
	const paths: string[] = [];
	const renames = new Map<string, string>();
	for (const line of out.split("\n")) {
		const [code, first, second] = line.split("\t");
		if (!code || !first) continue;
		if (code.startsWith("R") && second) {
			paths.push(second);
			renames.set(first, second);
		} else {
			paths.push(first);
		}
	}
	return { paths, renames };
}

/** Merges renames since the last head into the merge-base renames, chaining an old path through both to its final path. */
function composeRenames(
	range: ReadonlyMap<string, string>,
	since: ReadonlyMap<string, string>,
): Map<string, string> {
	const merged = new Map(range);
	for (const [from, to] of merged) {
		const next = since.get(to);
		if (next !== undefined) merged.set(from, next);
	}
	for (const [from, to] of since) if (!merged.has(from)) merged.set(from, to);
	return merged;
}

/** Paths to re-review on a delta round: range paths changed since the last head, plus paths whose open entries saw a different diff. */
function deltaPaths(
	changedSince: readonly string[],
	hashes: ReadonlyMap<string, string>,
	renames: ReadonlyMap<string, string>,
	entries: readonly LedgerEntry[],
): Set<string> {
	const only = new Set(changedSince.filter((p) => hashes.has(p)));
	for (const e of entries) {
		if (isSettled(e) || e.path === null) continue;
		const path = renames.get(e.path) ?? e.path;
		const hash = hashes.get(path);
		if (hash !== undefined && storedDiff(e) !== hash) only.add(path);
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

/** Owner and repo for the store key from any origin URL or path: its last two path segments, `local` as owner when fewer exist, and the top-level directory name when there is no origin. */
export function gateRepoSlug(
	origin: string | null,
	topLevel: string,
): { owner: string; repo: string } {
	const fallback = topLevel.split("/").filter(Boolean).at(-1) ?? "repo";
	if (!origin) return { owner: "local", repo: fallback };
	const path =
		/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.*)$/i.exec(origin)?.[1] ??
		/^[^/]+@[^:/]+:(.*)$/.exec(origin)?.[1] ??
		origin;
	const parts = path
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.split("/")
		.filter((p) => p !== "" && p !== "." && p !== "..");
	const repo = parts.at(-1) ?? fallback;
	return {
		owner: parts.length >= 2 ? (parts.at(-2) ?? "local") : "local",
		repo,
	};
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
	const rangeRenames = new Map(
		changes.flatMap((c) =>
			c.status === "R" && c.oldPath ? [[c.oldPath, c.path] as const] : [],
		),
	);

	const fullRescope =
		store.lastHead !== null && !isAncestor(runGit, store.lastHead);
	const since =
		store.lastHead === null || fullRescope
			? null
			: changesSince(runGit, store.lastHead);
	const renames = since
		? composeRenames(rangeRenames, since.renames)
		: rangeRenames;
	const only = since
		? deltaPaths(since.paths, hashes, renames, store.entries)
		: undefined;
	const files = await collectFilesFromRange({
		cwd: opts.cwd,
		changes,
		only,
		runGit,
	});
	const pass = files.length === 0 ? null : await review(files);
	const ran = (pass?.providerStats ?? []).filter((s) => s.succeeded > 0);

	const round = Math.max(0, ...store.entries.map((e) => e.round)) + 1;
	const result = applyRound({
		merged: pass?.merged ?? EMPTY_REVIEW,
		store,
		head,
		round,
		hashes,
		renames,
		reviewedPaths: only ?? "all",
		complete:
			pass === null ||
			(ran.length > 0 && ran.every((s) => s.attempted === s.succeeded)),
		providers: pass ? ran.map((s) => s.provider) : store.providers,
		fullRescope,
		storePath,
		idleProviders: (pass?.providerStats ?? []).filter((s) => s.succeeded === 0),
	});
	for (const w of result.warnings) console.error(w);

	const suggestions = new Map(
		result.emitted.map(({ entry, suggestion }) => [entry.id, suggestion]),
	);
	const open = result.store.entries.filter(
		(e) =>
			!isSettled(e) &&
			(e.path !== null ||
				suggestions.has(e.id) ||
				e.evidence.includes(`head:${head}`)),
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

	const save = () =>
		saveStore(storePath, result.store).catch((err: unknown) => {
			console.error(
				`Could not save gate history to ${storePath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		});

	if (opts.findingsFile) {
		await writeFile(opts.findingsFile, json);
		await save();
		return {
			exitCode: 0,
			stdout: `ai-review gate: ${kept.length} finding(s) written to ${opts.findingsFile}`,
			findings: kept,
		};
	}
	const stdout = formatText(kept);
	await save();
	return {
		exitCode: kept.some((f) => f.severity === "error") ? 1 : 0,
		stdout,
		findings: kept,
	};
}
