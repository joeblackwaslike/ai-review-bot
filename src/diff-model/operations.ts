import type { PushFile } from "../moved-blocks.js";
import { lexicallySafe, normalizeSafe } from "./lexical.js";
import type { Operation, Span } from "./types.js";

const RENAME_SIMILARITY = 0.6;

const TS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const PY_FILE = /\.pyi?$/i;
const MAX_IMPORT_LINE = 1000;
const MIN_RENAME_LINES = 3;
const MIN_LINE_LENGTH = 3;
const MAX_RENAME_FILES = 200;
const MAX_COUNT_SKEW = 0.4;
const UNSAFE_FILE_TEXT = /`|"{3}|'{3}|<<[-~]?\s*["']?\w/;
const NAMED_CLAUSE = String.raw`\{[^{}=()/]*\}`;
const NAMESPACE_CLAUSE = String.raw`\*(?:\s+as\s+[\w$]+)?`;
const TS_FROM = new RegExp(
	String.raw`^(import|export)\s+(type\s+)?(${NAMESPACE_CLAUSE}|${NAMED_CLAUSE}|[\w$]+(?:\s*,\s*(?:${NAMED_CLAUSE}|\*\s+as\s+[\w$]+))?)\s+from\s+(["'])([^"'\n]+)\4$`,
);
const TS_BARE = /^import\s+(["'])([^"'\n]+)\1$/;
const PY_PLAIN = /^import\s+([\w., ]+)$/;
const PY_FROM = /^from\s+([\w.]+)\s+import\s+(\*|[\w., ]+)$/;

interface HunkLines {
	groups: number;
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
	let inGroup = false;
	for (const line of (patch ?? "").split("\n")) {
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (header) {
			current = {
				groups: 0,
				context: [],
				deleted: [],
				added: [],
				baseRange: null,
				headRange: null,
			};
			hunks.push(current);
			inGroup = false;
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
		} else if (current && line.startsWith("-")) {
			if (!inGroup) current.groups++;
			inGroup = true;
			current.deleted.push(line.slice(1));
			current.baseRange = [current.baseRange?.[0] ?? oldLine, oldLine];
			oldLine++;
		} else if (current && line.startsWith("+")) {
			if (!inGroup) current.groups++;
			inGroup = true;
			current.added.push(line.slice(1));
			current.headRange = [current.headRange?.[0] ?? newLine, newLine];
			newLine++;
		} else if (current && line.startsWith(" ")) {
			inGroup = false;
			current.context.push(line.slice(1));
			oldLine++;
			newLine++;
		}
	}
	return hunks;
}

function sortedList(list: string): string {
	return list
		.split(",")
		.map((name) => name.trim().replace(/\s+/g, " "))
		.filter(Boolean)
		.sort()
		.join(",");
}

function tsImportKey(statement: string): string | null {
	const bare = TS_BARE.exec(statement);
	if (bare) return `import ${bare[2]}`;
	const from = TS_FROM.exec(statement);
	if (!from) return null;
	const clause = (from[3] ?? "")
		.replace(/\{([^}]*)\}/, (_, inner: string) => `{${sortedList(inner)}}`)
		.replace(/\s+/g, " ")
		.replace(/\s*,\s*/g, ",");
	return `${from[1]}${from[2] ? " type" : ""} ${clause} from ${from[5]}`;
}

function pyImportKey(statement: string): string | null {
	const plain = PY_PLAIN.exec(statement);
	if (plain) return `import ${sortedList(plain[1] ?? "")}`;
	const from = PY_FROM.exec(statement);
	if (from) return `from ${from[1]} import ${sortedList(from[2] ?? "")}`;
	return null;
}

function importKey(filename: string, line: string): string | null {
	if (line.length > MAX_IMPORT_LINE) return null;
	let statement = line.trim();
	if (statement.endsWith(";")) statement = statement.slice(0, -1).trimEnd();
	if (TS_FILE.test(filename)) return tsImportKey(statement);
	if (PY_FILE.test(filename)) return pyImportKey(statement);
	return null;
}

function isWhitespaceOnly(filename: string, hunk: HunkLines): boolean {
	if (hunk.groups !== 1) return false;
	if (hunk.deleted.length === 0 || hunk.deleted.length !== hunk.added.length) {
		return false;
	}
	const all = [...hunk.context, ...hunk.deleted, ...hunk.added];
	if (!lexicallySafe(filename, all)) return false;
	const before = normalizeSafe(filename, hunk.deleted);
	const after = normalizeSafe(filename, hunk.added);
	return (
		before.every((line, i) => line === after[i]) &&
		hunk.deleted.join("\n") !== hunk.added.join("\n")
	);
}

function importKeys(filename: string, lines: string[]): string[] | null {
	const keys: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const key = importKey(filename, line);
		if (key === null) return null;
		keys.push(key);
	}
	return keys.sort();
}

/**
 * Whether the hunk only reorders or reformats import statements: the same statements
 * on both sides. A pure addition or removal changes what is imported, so it is not.
 */
function isImportOnly(filename: string, hunk: HunkLines): boolean {
	const before = importKeys(filename, hunk.deleted);
	const after = importKeys(filename, hunk.added);
	return (
		before !== null &&
		after !== null &&
		before.length > 0 &&
		before.length === after.length &&
		before.every((key, i) => key === after[i])
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
 * Hunks that only change whitespace (one contiguous change group, lines paired in
 * order, in a lexically safe file) or only reorder and reformat import statements. An unsafe hunk is not reported, so it is reviewed as ordinary change.
 */
export function findMechanical(files: PushFile[]): Operation[] {
	const operations: Operation[] = [];
	for (const file of files) {
		const literalRisk = UNSAFE_FILE_TEXT.test(file.patch ?? "");
		for (const hunk of parseHunks(file.patch)) {
			if (
				(literalRisk || !isWhitespaceOnly(file.filename, hunk)) &&
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

interface RenameSide {
	file: PushFile;
	raw: string[];
	counts: Map<string, number>;
	meaningful: number;
}

function renameSide(file: PushFile, marker: "+" | "-"): RenameSide {
	const raw = (file.patch ?? "")
		.split("\n")
		.filter((l) => l.startsWith(marker))
		.map((l) => l.slice(1));
	const counts = new Map<string, number>();
	let meaningful = 0;
	for (const line of raw) {
		const text = line.trim();
		if (text.length < MIN_LINE_LENGTH) continue;
		meaningful++;
		counts.set(text, (counts.get(text) ?? 0) + 1);
	}
	return { file, raw, counts, meaningful };
}

function contentSimilarity(a: RenameSide, b: RenameSide): number {
	const [small, large] = a.counts.size <= b.counts.size ? [a, b] : [b, a];
	let shared = 0;
	for (const [line, n] of small.counts) {
		shared += Math.min(n, large.counts.get(line) ?? 0);
	}
	return shared / Math.max(a.meaningful, b.meaningful);
}

function pairable(a: RenameSide, b: RenameSide): boolean {
	if (a.meaningful < MIN_RENAME_LINES || b.meaningful < MIN_RENAME_LINES) {
		return false;
	}
	const longest = Math.max(a.meaningful, b.meaningful);
	return Math.abs(a.meaningful - b.meaningful) <= MAX_COUNT_SKEW * longest;
}

function sameSequence(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((line, i) => line === b[i]);
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
 * meaningful lines are at least `RENAME_SIMILARITY` alike. Exact means the deleted and
 * added files hold the same lines in the same order with the same indentation. Beyond
 * `MAX_RENAME_FILES` deleted or added files, none are paired.
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
					!file.patch && file.additions === 0 && file.deletions === 0,
				),
			);
		}
	}
	const unmatched = files.filter(isDeleted).map((f) => renameSide(f, "-"));
	const addedFiles = files.filter((f) => f.status === "added");
	if (
		unmatched.length > MAX_RENAME_FILES ||
		addedFiles.length > MAX_RENAME_FILES
	) {
		return operations;
	}
	for (const added of addedFiles.map((f) => renameSide(f, "+"))) {
		let best: { side: RenameSide; score: number } | null = null;
		for (const deleted of unmatched) {
			if (!pairable(deleted, added)) continue;
			const score = contentSimilarity(deleted, added);
			if (score >= RENAME_SIMILARITY && score > (best?.score ?? 0)) {
				best = { side: deleted, score };
			}
		}
		if (best) {
			unmatched.splice(unmatched.indexOf(best.side), 1);
			operations.push(
				renameOperation(
					operations.length + 1,
					best.side.file.filename,
					added.file.filename,
					sameSequence(best.side.raw, added.raw),
				),
			);
		}
	}
	return operations;
}
