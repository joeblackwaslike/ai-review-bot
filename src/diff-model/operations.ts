import type { PushFile } from "../moved-blocks.js";
import { lexicallySafe, normalizeSafe } from "./lexical.js";
import type { Operation, Span } from "./types.js";

const RENAME_SIMILARITY = 0.6;

const TS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const PY_FILE = /\.pyi?$/i;
const TS_IMPORT =
	/^\s*(?:(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["']|import\s+["'][^"']+["'])\s*;?\s*$/;
const PY_IMPORT =
	/^\s*(?:import\s+[\w., ]+|from\s+[\w.]+\s+import\s+(?:\*|[\w., ]+))\s*$/;

interface HunkLines {
	context: string[];
	deleted: string[];
	added: string[];
	baseRange: [number, number] | null;
	headRange: [number, number] | null;
}

function wholeFile(filename: string, side: Span["side"]): Span {
	return { filename, side, startLine: 1, endLine: 1, shown: "none" };
}

function parseHunks(patch: string | undefined): HunkLines[] {
	const hunks: HunkLines[] = [];
	let current: HunkLines | null = null;
	let oldLine = 0;
	let newLine = 0;
	for (const line of (patch ?? "").split("\n")) {
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (header) {
			current = {
				context: [],
				deleted: [],
				added: [],
				baseRange: null,
				headRange: null,
			};
			hunks.push(current);
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
		} else if (current && line.startsWith("-")) {
			current.deleted.push(line.slice(1));
			current.baseRange = [current.baseRange?.[0] ?? oldLine, oldLine];
			oldLine++;
		} else if (current && line.startsWith("+")) {
			current.added.push(line.slice(1));
			current.headRange = [current.headRange?.[0] ?? newLine, newLine];
			newLine++;
		} else if (current && line.startsWith(" ")) {
			current.context.push(line.slice(1));
			oldLine++;
			newLine++;
		}
	}
	return hunks;
}

function importPattern(filename: string): RegExp | null {
	if (TS_FILE.test(filename)) return TS_IMPORT;
	if (PY_FILE.test(filename)) return PY_IMPORT;
	return null;
}

function isWhitespaceOnly(filename: string, hunk: HunkLines): boolean {
	if (hunk.deleted.length === 0 || hunk.added.length === 0) return false;
	const all = [...hunk.context, ...hunk.deleted, ...hunk.added];
	if (!lexicallySafe(filename, all)) return false;
	const before = normalizeSafe(filename, hunk.deleted).filter(Boolean);
	const after = normalizeSafe(filename, hunk.added).filter(Boolean);
	return (
		before.length === after.length &&
		before.every((line, i) => line === after[i]) &&
		hunk.deleted.join("\n") !== hunk.added.join("\n")
	);
}

function isImportOnly(filename: string, hunk: HunkLines): boolean {
	const pattern = importPattern(filename);
	const changed = [...hunk.deleted, ...hunk.added].filter((l) => l.trim());
	return (
		pattern !== null &&
		changed.length > 0 &&
		changed.every((l) => pattern.test(l))
	);
}

function mechanicalSpans(filename: string, hunk: HunkLines) {
	const range = (side: Span["side"], r: [number, number] | null): Span[] =>
		r
			? [
					{
						filename,
						side,
						startLine: r[0],
						endLine: r[1],
						shown: "full",
					},
				]
			: [];
	return {
		from: range("base", hunk.baseRange),
		to: range("head", hunk.headRange),
	};
}

/**
 * Hunks that only change whitespace (in a lexically safe file) or only touch import
 * statements. An unsafe hunk is not reported, so it is reviewed as ordinary change.
 */
export function findMechanical(files: PushFile[]): Operation[] {
	const operations: Operation[] = [];
	for (const file of files) {
		for (const hunk of parseHunks(file.patch)) {
			if (
				!isWhitespaceOnly(file.filename, hunk) &&
				!isImportOnly(file.filename, hunk)
			) {
				continue;
			}
			operations.push({
				id: `mechanical-${operations.length + 1}`,
				type: "mechanical",
				...mechanicalSpans(file.filename, hunk),
				exact: true,
				divergences: [],
				reviewWeight: 0,
			});
		}
	}
	return operations;
}

function fileLines(file: PushFile): string[] {
	return (file.patch ?? "")
		.split("\n")
		.filter((l) => l.startsWith("+") || l.startsWith("-"))
		.map((l) => l.slice(1).trim())
		.filter(Boolean);
}

function contentSimilarity(a: PushFile, b: PushFile): number {
	const counts = new Map<string, number>();
	for (const line of fileLines(a))
		counts.set(line, (counts.get(line) ?? 0) + 1);
	const other = fileLines(b);
	let shared = 0;
	for (const line of other) {
		const n = counts.get(line) ?? 0;
		if (n > 0) {
			shared++;
			counts.set(line, n - 1);
		}
	}
	const longest = Math.max(fileLines(a).length, other.length);
	return longest === 0 ? 0 : shared / longest;
}

function renameOperation(
	k: number,
	from: string,
	to: string,
	exact: boolean,
): Operation {
	return {
		id: `rename-${k}`,
		type: "rename",
		from: [wholeFile(from, "base")],
		to: [wholeFile(to, "head")],
		exact,
		divergences: [],
		reviewWeight: exact ? 0 : 1,
	};
}

const isDeleted = (f: PushFile) =>
	f.status === "removed" || f.status === "deleted";

/**
 * Renames git reported, plus a deleted and an added file git left unpaired whose
 * content is at least `RENAME_SIMILARITY` alike.
 */
export function findRenames(files: PushFile[]): Operation[] {
	const operations: Operation[] = [];
	for (const file of files) {
		if (file.status === "renamed" && file.previous_filename) {
			operations.push(
				renameOperation(
					operations.length + 1,
					file.previous_filename,
					file.filename,
					!file.patch,
				),
			);
		}
	}
	const unmatched = files.filter(isDeleted);
	for (const added of files.filter((f) => f.status === "added")) {
		let best: { file: PushFile; score: number } | null = null;
		for (const deleted of unmatched) {
			const score = contentSimilarity(deleted, added);
			if (score >= RENAME_SIMILARITY && score > (best?.score ?? 0)) {
				best = { file: deleted, score };
			}
		}
		if (best) {
			unmatched.splice(unmatched.indexOf(best.file), 1);
			operations.push(
				renameOperation(
					operations.length + 1,
					best.file.filename,
					added.filename,
					best.score === 1,
				),
			);
		}
	}
	return operations;
}
