import type { Candidate, Run } from "../moved-blocks.js";
import type { WorkBudget } from "./budget.js";

const MIN_COUNTED_LINES = 5;
const MIN_INFORMATION = 30;
const MIN_DEFINITION_CHARS = 40;

const KEYWORDS = new Set(
	`if else elif for while do return break continue switch case default try catch
	finally except throw raise new function class def fn func end let const var in of
	async await yield import export from as true false null undefined none nil self
	this super static public private protected void and or not is then begin pub mut
	type interface enum extends implements`.split(/\s+/),
);
const DEFINITION_OPENER =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b|def\b|fn\b|func\b|pub\s+fn\b|const\s+[A-Za-z_$]|type\s+\w|interface\s+\w|enum\s+\w)/;
const DEFINITION_CLOSER = /^(?:[}\]]|end\b)/;
const IMPORT_LIKE =
	/^(?:import\b|export\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?(?:from\b|;|$)|from\s+\S+\s+import\b|use\s+[\w:{]|require(?:_relative)?\b|#include\b|using\s+[\w.]+\s*;|package\b)|\brequire\s*\(|\bimport\s*\(/;
const LITERAL =
	/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d[\w.]*/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const ONLY_PUNCTUATION = /^[\s,;:()[\]{}]*$/;

const uniquenessIndexes = new WeakMap<
	Run[],
	Map<number, Map<string, number>>
>();

function nonSpace(text: string): number {
	return text.replace(/\s/g, "").length;
}

/**
 * How much a line says about its block: its non-space character count when it has a
 * non-keyword identifier, or a string or number literal that is not the whole line. Closers,
 * bare keywords, imports, requires, uses, re-exports and bare literals carry none.
 */
export function lineInformation(line: string): number {
	const text = line.trim();
	if (text === "" || IMPORT_LIKE.test(text)) return 0;
	const withoutLiterals = text.replace(LITERAL, " ");
	const hasLiteral = text.match(LITERAL) !== null;
	const names = withoutLiterals.match(IDENTIFIER) ?? [];
	const hasName = names.some((name) => !KEYWORDS.has(name));
	if (hasName) return nonSpace(text);
	if (hasLiteral && !ONLY_PUNCTUATION.test(withoutLiterals.trim()))
		return nonSpace(text);
	return 0;
}

function windowCounts(runs: Run[], size: number): Map<string, number> {
	let bySize = uniquenessIndexes.get(runs);
	if (!bySize) {
		bySize = new Map();
		uniquenessIndexes.set(runs, bySize);
	}
	const cached = bySize.get(size);
	if (cached) return cached;
	const counts = new Map<string, number>();
	for (const run of runs) {
		for (let k = 0; k + size <= run.lines.length; k++) {
			const key = run.lines.slice(k, k + size).join("\n");
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	bySize.set(size, counts);
	return counts;
}

/**
 * True when the candidate's joined normalized text occurs at most once among the deleted runs
 * and at most once among the added runs of the whole change.
 */
export function isUnique(c: Candidate, deleted: Run[], added: Run[]): boolean {
	const key = c.from.lines
		.slice(c.fromStart, c.fromStart + c.length)
		.join("\n");
	return (
		(windowCounts(deleted, c.length).get(key) ?? 0) <= 1 &&
		(windowCounts(added, c.length).get(key) ?? 0) <= 1
	);
}

function isWholeDefinition(c: Candidate): boolean {
	const lines = c.from.lines
		.slice(c.fromStart, c.fromStart + c.length)
		.filter((line) => line.trim() !== "");
	const first = lines[0]?.trim();
	const last = lines[lines.length - 1]?.trim();
	if (first === undefined || last === undefined) return false;
	if (!DEFINITION_OPENER.test(first)) return false;
	if (c.from.indentSensitive) return true;
	if (lines.length === 1) return /[}\]][;,]?$/.test(last);
	return DEFINITION_CLOSER.test(last);
}

/**
 * Decides whether an exact run is a block worth reporting. Five or more counted lines always
 * qualify. One to four lines qualify when they carry at least 30 characters of information
 * and occur once on each side, or form a whole definition of at least 40 non-space
 * characters that occurs once on each side. Each call draws one candidate and the seed's
 * characters from the budget, and rejects once either pool runs dry.
 */
export function acceptSeed(
	c: Candidate,
	ctx: { deleted: Run[]; added: Run[]; budget?: WorkBudget },
): boolean {
	if (c.counted >= MIN_COUNTED_LINES) return true;
	const lines = c.from.lines.slice(c.fromStart, c.fromStart + c.length);
	const chars = nonSpace(lines.join(""));
	if (ctx.budget) {
		if (!ctx.budget.spendCandidates(1)) return false;
		if (!ctx.budget.spendTokens(chars)) return false;
	}
	const definition = isWholeDefinition(c);
	const enough = definition
		? chars >= MIN_DEFINITION_CHARS
		: lines.reduce((sum, line) => sum + lineInformation(line), 0) >=
			MIN_INFORMATION;
	return enough && isUnique(c, ctx.deleted, ctx.added);
}
