import { numberPatchLines } from "./diff-lines.js";

const GENERATED_NAMES = new Set([
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"Cargo.lock",
	"poetry.lock",
	"go.sum",
]);

/** Lock and generated files, which reviewers are not expected to read. */
export function isGeneratedFile(path: string): boolean {
	const name = path.split("/").pop() ?? path;
	return (
		GENERATED_NAMES.has(name) ||
		name.endsWith(".min.js") ||
		name.endsWith(".snap")
	);
}

/** PR-wide diff budget, in characters of numbered patch text. */
export const DEFAULT_DIFF_BUDGET_CHARS = 200_000;

const TRUNCATION_MARKER = "[patch truncated]";
const MARKER_COST = `\n\n${TRUNCATION_MARKER}`.length;
const CONTEXT_BEFORE = 5;
const CONTEXT_AFTER = 1;
const FUNCTION_REACH = 20;
// ponytail: keyword heuristic, a per-language parser if it misses too often
const FUNCTION_START =
	/^\s*(?:export\s+)?(?:default\s+)?(?:pub\s+)?(?:async\s+)?(?:function|class|def|fn|func|interface)\b|=>\s*\{\s*$/;
const HUNK_RANGE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A PR file as GitHub lists it. */
export interface PackInputFile {
	filename: string;
	status: string;
	patch?: string;
}

/** A file as the model sees it after packing. `patch` holds whole hunks of the
 * GitHub patch (deletion-only hunks dropped), ending in `[patch truncated]` when
 * the budget cut it; it is undefined for a file with no patch or no hunk left. */
export interface PackedFile {
	filename: string;
	status: string;
	patch?: string;
	truncated: boolean;
	deletionsOnly: boolean;
}

/** `budgetChars` caps the numbered patch text across the whole PR. */
export interface PackOptions {
	budgetChars: number;
	/** Full new-side text by filename. When present, that file's hunks get
	 * asymmetric context (see `widenHunks`). */
	fileText?: ReadonlyMap<string, string>;
}

interface Split {
	preamble: string[];
	hunks: string[][];
}

function splitHunks(patch: string): Split {
	const split: Split = { preamble: [], hunks: [] };
	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) split.hunks.push([line]);
		else (split.hunks.at(-1) ?? split.preamble).push(line);
	}
	return split;
}

const hasAddition = (hunk: string[]) =>
	hunk.some((line, i) => i > 0 && line.startsWith("+"));

const extensionOf = (filename: string) => {
	const base = filename.split("/").pop() ?? filename;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

const countAdded = (patch: string | undefined) =>
	(patch ?? "").split("\n").filter((line) => line.startsWith("+")).length;

function orderFiles<T extends PackInputFile>(files: readonly T[]): T[] {
	const addedByExt = new Map<string, number>();
	for (const f of files) {
		if (isGeneratedFile(f.filename)) continue;
		const ext = extensionOf(f.filename);
		addedByExt.set(ext, (addedByExt.get(ext) ?? 0) + countAdded(f.patch));
	}
	const rank = (f: T) => addedByExt.get(extensionOf(f.filename)) ?? 0;
	return [...files].sort(
		(a, b) =>
			Number(isGeneratedFile(a.filename)) -
				Number(isGeneratedFile(b.filename)) ||
			rank(b) - rank(a) ||
			extensionOf(a.filename).localeCompare(extensionOf(b.filename)) ||
			(b.patch?.length ?? 0) - (a.patch?.length ?? 0) ||
			a.filename.localeCompare(b.filename),
	);
}

/** Widen each hunk with new-side context from `fileText`: at least 5 lines
 * before the first change, reaching back to an enclosing function start within
 * 20 lines, and at least 1 line after. Never overlaps a neighbouring hunk. */
export function widenHunks(patch: string, fileText: string): string {
	const text = fileText.split("\n");
	const { preamble, hunks } = splitHunks(patch);
	let prevEnd = 0;
	const widened = hunks.map((hunk, h) => {
		const m = HUNK_RANGE.exec(hunk[0]);
		if (!m) return hunk;
		const oldCount = m[2] === undefined ? 1 : Number(m[2]);
		const newCount = m[4] === undefined ? 1 : Number(m[4]);
		const oldFirst = Number(m[1]) + (oldCount === 0 ? 1 : 0);
		const newFirst = Number(m[3]) + (newCount === 0 ? 1 : 0);
		const body = hunk.slice(1);
		const leading = body.findIndex((l) => !l.startsWith(" "));
		const lead = leading === -1 ? body.length : leading;
		const nextMatch = hunks[h + 1] ? HUNK_RANGE.exec(hunks[h + 1][0]) : null;
		const nextFirst = nextMatch ? Number(nextMatch[3]) : text.length + 1;
		const floor = prevEnd + 1;
		let start = Math.max(floor, newFirst - Math.max(0, CONTEXT_BEFORE - lead));
		for (
			let n = newFirst - 1;
			n >= Math.max(floor, newFirst - FUNCTION_REACH);
			n--
		) {
			if (FUNCTION_START.test(text[n - 1] ?? "")) {
				start = Math.min(start, n);
				break;
			}
		}
		const before = text.slice(start - 1, newFirst - 1).map((l) => ` ${l}`);
		const trailing = [...body].reverse().findIndex((l) => !l.startsWith(" "));
		const trail = trailing === -1 ? body.length : trailing;
		const newEnd = newFirst + newCount - 1;
		const afterCount = Math.max(
			0,
			Math.min(
				CONTEXT_AFTER - trail,
				nextFirst - 1 - newEnd,
				text.length - newEnd,
			),
		);
		const after = text.slice(newEnd, newEnd + afterCount).map((l) => ` ${l}`);
		prevEnd = newEnd + afterCount;
		const added = before.length + after.length;
		if (added === 0) return hunk;
		const header = `@@ -${oldFirst - before.length},${oldCount + added} +${newFirst - before.length},${newCount + added} @@${m[5]}`;
		return [header, ...before, ...body, ...after];
	});
	return [...preamble, ...widened.flat()].join("\n");
}

interface Prepared {
	lines: string[];
	/** `cost[k]`: chars of the first k numbered lines joined by newlines. */
	cost: number[];
	boundaries: number[];
	deletionsOnly: boolean;
}

function prepare(patch: string): Prepared {
	const { preamble, hunks } = splitHunks(patch);
	const kept = hunks.filter(hasAddition);
	const deletionsOnly = hunks.length > 0 && kept.length === 0;
	const lines = deletionsOnly ? [] : [...preamble, ...kept.flat()];
	const boundaries: number[] = [];
	let at = preamble.length;
	if (at > 0) boundaries.push(at);
	for (const hunk of kept) {
		at += hunk.length;
		boundaries.push(at);
	}
	const numbered =
		lines.length > 0 ? numberPatchLines(lines.join("\n")).split("\n") : [];
	const cost = [0];
	for (const [i, line] of numbered.entries())
		cost.push(cost[i] + line.length + (i > 0 ? 1 : 0));
	return { lines, cost, boundaries, deletionsOnly };
}

function cutPoint(p: Prepared, avail: number): number {
	const atBoundary = p.boundaries.filter((b) => p.cost[b] <= avail).at(-1);
	if (atBoundary !== undefined) return atBoundary;
	let count = 0;
	while (count < p.lines.length && p.cost[count + 1] <= avail) count++;
	return p.lines
		.slice(0, count)
		.some((l) => l.startsWith("+") || l.startsWith(" "))
		? count
		: 0;
}

/** Pack a PR's patches into one character budget, measured on the numbered
 * text `numberPatchLines` produces. Files go main language first (the
 * extension with the most added lines), larger patches first within a
 * language, generated files last. Deletion-only hunks are dropped. Whole files
 * fit until one would cross the budget; that one is cut at a hunk boundary (or
 * mid-hunk, by whole lines, when its first hunk alone is too big) and every
 * later file with content is listed in `omitted`. A file of which nothing fits
 * is omitted and packing goes on. */
export function packDiff(
	files: readonly PackInputFile[],
	opts: PackOptions,
): { files: PackedFile[]; omitted: string[] } {
	let remaining = opts.budgetChars;
	let cut = false;
	const packed: PackedFile[] = [];
	const omitted: string[] = [];
	for (const file of orderFiles(files)) {
		const base = { filename: file.filename, status: file.status };
		if (!file.patch) {
			packed.push({
				...base,
				patch: undefined,
				truncated: false,
				deletionsOnly: false,
			});
			continue;
		}
		const text = opts.fileText?.get(file.filename);
		const p = prepare(
			text === undefined ? file.patch : widenHunks(file.patch, text),
		);
		if (p.deletionsOnly) {
			packed.push({
				...base,
				patch: undefined,
				truncated: false,
				deletionsOnly: true,
			});
			continue;
		}
		if (cut) {
			omitted.push(file.filename);
			continue;
		}
		const cost = p.cost[p.lines.length];
		if (cost <= remaining) {
			packed.push({
				...base,
				patch: p.lines.join("\n"),
				truncated: false,
				deletionsOnly: false,
			});
			remaining -= cost;
			continue;
		}
		const count = cutPoint(p, remaining - MARKER_COST);
		if (count === 0) {
			omitted.push(file.filename);
			continue;
		}
		packed.push({
			...base,
			patch: `${p.lines.slice(0, count).join("\n")}\n\n${TRUNCATION_MARKER}`,
			truncated: true,
			deletionsOnly: false,
		});
		cut = true;
	}
	return { files: packed, omitted };
}
