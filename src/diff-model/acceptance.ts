import type { Candidate, Run } from "../moved-blocks.js";
import type { WorkBudget } from "./budget.js";
import { isProseFile, MAX_ANALYZED_LINE } from "./lexical.js";

export const MIN_COUNTED_LINES = 5;
const MIN_INFORMATION = 30;
const MIN_SAME_FILE_INFORMATION = 50;
const MIN_DEFINITION_CHARS = 40;

const KEYWORDS = new Set(
	`if else elif for while do return break continue switch case default try catch
	finally except throw raise new function class def fn func end let const var in of
	async await yield import export from as true false null undefined none nil self
	this super static public private protected void and or not is then begin pub mut
	type interface enum extends implements None True False pass with lambda del
	assert defer go range impl match elsif unless`.split(/\s+/),
);
const DEFINITION_OPENER =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b|def\b|fn\b|func\b|pub\s+fn\b|const\s+[A-Za-z_$]|type\s+\w|interface\s+\w|enum\s+\w)/;
const DEFINITION_CLOSER = /^(?:[}\]]|end\b)/;
const LEADING_OPERATOR = /^(?:\.|[?:,=^%&|*+-]|\/(?![/*]))/;
const LEADING_OPERATOR_IN_LISTED_FILES =
	/^(?:\.[A-Za-z_$]|[?:]|=>|\+|,|&&|\|\|)/;
const CLOSER_START = /^[)\]}]/;
const TERMINATOR = /(?:[;}\])]|\b(?:end|fi|done|esac))$/;
const CONTINUING_START = /^(?:(?:as|satisfies|instanceof|in)\s|[([`])/;
const SIGNATURE_START =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b|def\b|fn\b|func\b|pub\s+fn\b|interface\b|enum\b)/;
const MAX_SITES = 50;
const OPEN_ENDING = /(?:[=+*%&|^?:\\([-]|=>)$/;
const IMPORT_LIKE =
	/^(?:import\b|export\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?(?:from\b|;|$)|from\s+\S+\s+import\b|use\s+[\w:{]|require(?:_relative)?\b|#include\b|using\s+[\w.]+\s*;|package\b)|\brequire\s*\(|\bimport\s*\(/;
const LITERAL =
	/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d[\w.]*/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const ONLY_PUNCTUATION = /^[\s,;:()[\]{}]*$/;

interface LineSite {
	run: Run;
	at: number;
}

const firstLineIndexes = new WeakMap<Run[], Map<string, LineSite[]>>();

function nonSpace(text: string): number {
	return text.replace(/\s/g, "").length;
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/**
 * How much a line says about its block: its non-space character count when it has a
 * non-keyword identifier, or a string or number literal that is not the whole line. Closers,
 * bare keywords, imports, requires, uses, re-exports and bare literals carry none. A line
 * longer than 2000 characters carries none, so a crafted line never reaches the literal scan.
 */
export function lineInformation(line: string): number {
	const text = line.trim();
	if (text === "" || text.length > MAX_ANALYZED_LINE || IMPORT_LIKE.test(text))
		return 0;
	const withoutLiterals = text.replace(LITERAL, " ");
	const hasLiteral = text.match(LITERAL) !== null;
	const names = withoutLiterals.match(IDENTIFIER) ?? [];
	const hasName = names.some((name) => !KEYWORDS.has(name));
	if (hasName) return nonSpace(text);
	if (hasLiteral && !ONLY_PUNCTUATION.test(withoutLiterals.trim()))
		return nonSpace(text);
	return 0;
}

function lineIndex(runs: Run[]): Map<string, LineSite[]> {
	let index = firstLineIndexes.get(runs);
	if (!index) {
		index = new Map();
		for (const run of runs) {
			run.lines.forEach((line, at) => {
				const sites = index?.get(line);
				if (sites) sites.push({ run, at });
				else index?.set(line, [{ run, at }]);
			});
		}
		firstLineIndexes.set(runs, index);
	}
	return index;
}

function occurrences(runs: Run[], window: string[]): number {
	let found = 0;
	const sites = lineIndex(runs).get(window[0] as string) ?? [];
	if (sites.length > MAX_SITES) return 2;
	for (const { run, at } of sites) {
		if (at + window.length > run.lines.length) continue;
		if (window.every((line, k) => run.lines[at + k] === line) && ++found > 1)
			break;
	}
	return found;
}

/**
 * True when the candidate's joined normalized text occurs at most once among the deleted runs
 * and at most once among the added runs of the whole change.
 */
export function isUnique(c: Candidate, deleted: Run[], added: Run[]): boolean {
	const window = c.from.lines.slice(c.fromStart, c.fromStart + c.length);
	return occurrences(deleted, window) <= 1 && occurrences(added, window) <= 1;
}

const drawn = new WeakMap<WorkBudget, Set<string>>();

function drawBudget(c: Candidate, chars: number, budget: WorkBudget): boolean {
	const key = `${c.from.index}|${c.to.index}|${c.fromStart}|${c.toStart}|${c.length}`;
	let keys = drawn.get(budget);
	if (!keys) {
		keys = new Set();
		drawn.set(budget, keys);
	}
	if (keys.has(key)) return true;
	if (!budget.spendCandidates(1) || !budget.spendTokens(chars)) return false;
	keys.add(key);
	return true;
}

function isOpenSingleLine(c: Candidate, lines: string[]): boolean {
	const present = lines.filter((line) => line.trim() !== "");
	if (present.length !== 1) return false;
	const only = present[0] as string;
	if (c.from.indentSensitive && only.trimEnd().endsWith(":")) return true;
	const code = only.replace(LITERAL, "");
	const opened = (code.match(/[([{]/g) ?? []).length;
	const closed = (code.match(/[)\]}]/g) ?? []).length;
	return opened > closed;
}

function isWholeDefinition(c: Candidate): boolean {
	const lines = c.from.lines
		.slice(c.fromStart, c.fromStart + c.length)
		.filter((line) => line.trim() !== "");
	const first = lines[0]?.trim();
	const last = lines[lines.length - 1]?.trim();
	if (first === undefined || last === undefined) return false;
	if (!DEFINITION_OPENER.test(first)) return false;
	if (c.from.indentSensitive) return lines.length > 1 || !last.endsWith(":");
	if (lines.length === 1) return /[}\]][;,]?$/.test(last);
	return DEFINITION_CLOSER.test(last);
}

function listsItems(run: Run): boolean {
	return run.indentSensitive || isProseFile(run.filename);
}

/** True when a line opens with a closing bracket or a leading operator (a narrower set in files that list items with `-`, `*` and `+`). */
export function startsMidStatement(line: string, run: Run): boolean {
	const text = line.trim();
	if (CLOSER_START.test(text)) return true;
	return (
		listsItems(run) ? LEADING_OPERATOR_IN_LISTED_FILES : LEADING_OPERATOR
	).test(text);
}

function lastPresentLine(run: Run, start: number, end: number): string {
	for (let k = end - 1; k >= start; k--) {
		const line = run.raw[k] as string;
		if (line.trim() !== "") return line;
	}
	return "";
}

function stripComment(line: string, run: Run): string {
	const hash = run.indentSensitive;
	const slash = !hash && !isProseFile(run.filename);
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
		} else if (
			(slash && ch === "/" && line[i + 1] === "/") ||
			(hash && ch === "#")
		) {
			return line.slice(0, i);
		}
	}
	return line;
}

function bracketsBalance(run: Run, start: number, end: number): boolean {
	const rows = run.raw.slice(start, end);
	const lastAt = rows.reduce((at, row, k) => (row.trim() === "" ? at : k), -1);
	const signature = SIGNATURE_START.test(
		rows.find((r) => r.trim())?.trim() ?? "",
	);
	let depth = 0;
	for (const [k, row] of rows.entries()) {
		if (row.length > MAX_ANALYZED_LINE) return false;
		let code = stripComment(row, run).replace(LITERAL, "");
		if (signature && k === lastAt) code = code.replace(/\{\s*$/, "");
		for (const ch of code) {
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if ((ch === ")" || ch === "]" || ch === "}") && --depth < 0)
				return false;
		}
	}
	return depth === 0;
}

/**
 * True when the statement ending at line `end` of the run may carry on: its brackets do not
 * balance (a signature may end in `{`), its last line, minus a trailing comment, ends in an
 * operator, or the next line (in the run, or the context line after it) continues it. See
 * the matching v2 spec for the exact tests.
 */
export function leavesStatementOpen(
	run: Run,
	start: number,
	end: number,
): boolean {
	const last = lastPresentLine(run, start, end);
	if (last === "") return false;
	if (!bracketsBalance(run, start, end)) return true;
	const code = stripComment(last, run).trimEnd();
	if (OPEN_ENDING.test(code)) return true;
	const next = end < run.raw.length ? run.raw[end] : run.after;
	const text = next?.trim() ?? "";
	if (text === "") return false;
	const deeper = indentOf(next as string) > indentOf(last);
	if (CLOSER_START.test(text)) return deeper;
	if (startsMidStatement(text, run)) return true;
	if (listsItems(run)) return deeper;
	return CONTINUING_START.test(text) || !TERMINATOR.test(code);
}

/**
 * Decides whether an exact run is a block worth reporting. Five or more counted lines
 * qualify, drawing one candidate from the budget and, within one file, needing unique text.
 * One to four lines draw a candidate and their characters, and need 30 characters of
 * information (50 within one file) or a whole definition of 40, unique on each side, no
 * line over 2000 characters, no mid-statement start, no `leavesStatementOpen` on either
 * side, and different hunks within one file.
 */
export function acceptSeed(
	c: Candidate,
	ctx: { deleted: Run[]; added: Run[]; budget?: WorkBudget },
): boolean {
	const sameFile = c.from.filename === c.to.filename;
	if (c.counted >= MIN_COUNTED_LINES)
		return (
			(!sameFile || isUnique(c, ctx.deleted, ctx.added)) &&
			(!ctx.budget || drawBudget(c, 0, ctx.budget))
		);
	const lines = c.from.lines.slice(c.fromStart, c.fromStart + c.length);
	if (lines.some((line) => line.length > MAX_ANALYZED_LINE)) return false;
	const chars = nonSpace(lines.join(""));
	if (ctx.budget && !drawBudget(c, chars, ctx.budget)) return false;
	if (isOpenSingleLine(c, lines)) return false;
	if (startsMidStatement(lines.find((l) => l.trim() !== "") ?? "", c.from))
		return false;
	if (
		leavesStatementOpen(c.from, c.fromStart, c.fromStart + c.length) ||
		leavesStatementOpen(c.to, c.toStart, c.toStart + c.length)
	)
		return false;
	if (sameFile && c.from.hunk === c.to.hunk) return false;
	const information = lines.reduce(
		(sum, line) => sum + lineInformation(line),
		0,
	);
	const enough =
		information >= (sameFile ? MIN_SAME_FILE_INFORMATION : MIN_INFORMATION) ||
		(isWholeDefinition(c) && chars >= MIN_DEFINITION_CHARS);
	return enough && isUnique(c, ctx.deleted, ctx.added);
}
