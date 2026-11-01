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

/** PR-wide diff budget, in characters of the serialized diff section. */
export const DEFAULT_DIFF_BUDGET_CHARS = 200_000;

const TRUNCATION_MARKER = "[patch truncated]";
const MARKER_COST = `\n\n${TRUNCATION_MARKER}`.length;
const FILE_SEPARATOR = "\n\n---\n\n";
const OMITTED_PREFIX = "Files not shown (over the diff budget): ";
const MAX_OMITTED_NAMES = 100;

/** A PR file as GitHub lists it. */
export interface PackInputFile {
	filename: string;
	status: string;
	patch?: string;
}

/** A file as the model sees it after packing. `patch` holds whole hunks of the
 * GitHub patch (deletion-only hunks dropped and counted in
 * `droppedDeletionHunks`), ending in `[patch truncated]` when the budget cut
 * it; it is undefined for a file with no patch or no hunk left. */
export interface PackedFile {
	filename: string;
	status: string;
	patch?: string;
	truncated: boolean;
	deletionsOnly: boolean;
	droppedDeletionHunks: number;
}

/** Files shown, in prompt order, and the names of the files left out. */
export interface PackedDiff {
	files: PackedFile[];
	omitted: string[];
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

/** True when the patch has hunks and none of them adds a line. */
export function isDeletionOnlyPatch(patch: string | undefined): boolean {
	if (!patch) return false;
	const { hunks } = splitHunks(patch);
	return hunks.length > 0 && !hunks.some(hasAddition);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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
			cmp(extensionOf(a.filename), extensionOf(b.filename)) ||
			(b.patch?.length ?? 0) - (a.patch?.length ?? 0) ||
			cmp(a.filename, b.filename),
	);
}

function patchLabel(file: PackedFile): string {
	if (file.deletionsOnly) return "PATCH: [deletions only]";
	if (!file.patch) return "PATCH: [not available]";
	return file.truncated
		? "PATCH (truncated at the diff budget, later hunks not shown):\n"
		: "PATCH:\n";
}

/** Everything in a file's block except the numbered patch text. */
function fileFrame(file: PackedFile): string {
	const n = file.patch ? file.droppedDeletionHunks : 0;
	const note =
		n > 0
			? `(${n} deletion-only ${n === 1 ? "hunk" : "hunks"} not shown)\n`
			: "";
	return `FILE: ${file.filename}\nSTATUS: ${file.status}\n${note}${patchLabel(file)}`;
}

function formatFile(file: PackedFile): string {
	return `${fileFrame(file)}${file.patch ? numberPatchLines(file.patch) : ""}`;
}

function omittedSection(names: readonly string[]): string {
	if (names.length === 0) return "";
	const shown = names.slice(0, MAX_OMITTED_NAMES);
	const more = names.length - shown.length;
	return `${OMITTED_PREFIX}${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}\n\n`;
}

/** The longest omitted section any subset of these names can produce. */
function omittedUpperBound(names: readonly string[]): number {
	const longest = names
		.map((n) => n.length)
		.sort((a, b) => b - a)
		.slice(0, MAX_OMITTED_NAMES);
	const more =
		names.length > MAX_OMITTED_NAMES ? `, and ${names.length} more`.length : 0;
	return (
		OMITTED_PREFIX.length + longest.reduce((n, l) => n + l + 2, 0) + more + 2
	);
}

/** The diff section of the prompt: the omitted-files line, then each file's
 * block. `packDiff` keeps its length within the budget. */
export function formatPackedDiff(diff: PackedDiff): string {
	return `${omittedSection(diff.omitted)}${diff.files.map(formatFile).join(FILE_SEPARATOR)}`;
}

interface Prepared {
	input: PackInputFile;
	lines: string[];
	/** `cost[k]`: chars of the first k numbered lines joined by newlines. */
	cost: number[];
	boundaries: number[];
	/** Fewest leading lines that include a right-side (`+` or context) line. */
	minCut: number;
	deletionsOnly: boolean;
	dropped: number;
}

function prepare(input: PackInputFile): Prepared {
	const { preamble, hunks } = splitHunks(input.patch ?? "");
	const kept = hunks.filter(hasAddition);
	const deletionsOnly = hunks.length > 0 && kept.length === 0;
	const lines =
		!input.patch || deletionsOnly ? [] : [...preamble, ...kept.flat()];
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
	const firstRight = lines.findIndex(
		(l) => l.startsWith("+") || l.startsWith(" "),
	);
	return {
		input,
		lines,
		cost,
		boundaries,
		minCut: firstRight === -1 ? Number.POSITIVE_INFINITY : firstRight + 1,
		deletionsOnly,
		dropped: hunks.length - kept.length,
	};
}

function cutPoint(p: Prepared, avail: number): number {
	const atBoundary = p.boundaries
		.filter((b) => b >= p.minCut && p.cost[b] <= avail)
		.at(-1);
	if (atBoundary !== undefined) return atBoundary;
	let count = 0;
	while (count < p.lines.length && p.cost[count + 1] <= avail) count++;
	return count >= p.minCut ? count : 0;
}

function packWithin(items: readonly Prepared[], budget: number): PackedDiff {
	let remaining = budget;
	let cut = false;
	const files: PackedFile[] = [];
	const omitted: string[] = [];
	for (const p of items) {
		if (cut) {
			omitted.push(p.input.filename);
			continue;
		}
		const sep = files.length > 0 ? FILE_SEPARATOR.length : 0;
		const whole: PackedFile = {
			filename: p.input.filename,
			status: p.input.status,
			patch: p.lines.length > 0 ? p.lines.join("\n") : undefined,
			truncated: false,
			deletionsOnly: p.deletionsOnly,
			droppedDeletionHunks: p.dropped,
		};
		const cost = sep + fileFrame(whole).length + p.cost[p.lines.length];
		if (cost <= remaining) {
			files.push(whole);
			remaining -= cost;
			continue;
		}
		const partial = { ...whole, truncated: true };
		const frame = fileFrame({ ...partial, patch: "x" }).length;
		const count =
			p.lines.length > 0
				? cutPoint(p, remaining - sep - frame - MARKER_COST)
				: 0;
		if (count === 0) {
			omitted.push(p.input.filename);
			continue;
		}
		files.push({
			...partial,
			patch: `${p.lines.slice(0, count).join("\n")}\n\n${TRUNCATION_MARKER}`,
		});
		cut = true;
	}
	return { files, omitted };
}

/** Pack a PR's patches into one budget for the whole serialized diff section
 * (`formatPackedDiff`): file framing, numbered patch text and the
 * omitted-files line all count. Files go main language first (the extension
 * with the most added lines), larger patches first within a language,
 * generated files last. Deletion-only hunks are dropped and counted in a note.
 * Whole files fit until one would cross the budget; that one is cut at a hunk
 * boundary (or mid-hunk, by whole lines, when its first hunk alone is too big)
 * and every later file is named in `omitted`. A file of which nothing fits is
 * omitted and packing goes on. When the budget cannot hold even the omitted
 * list, every file is omitted: the output is only that list, never silent. */
export function packDiff(
	files: readonly PackInputFile[],
	opts: { budgetChars: number },
): PackedDiff {
	const items = orderFiles(files).map(prepare);
	const first = packWithin(items, opts.budgetChars);
	const need = omittedSection(first.omitted).length;
	if (need === 0) return first;
	const second = packWithin(items, opts.budgetChars - need);
	if (omittedSection(second.omitted).length <= need) return second;
	return packWithin(
		items,
		opts.budgetChars - omittedUpperBound(files.map((f) => f.filename)),
	);
}
