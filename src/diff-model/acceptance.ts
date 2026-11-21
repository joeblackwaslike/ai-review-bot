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
const CONTROL_START =
	/^(?:if|else|elif|while|for|foreach|switch|case|when|unless|until|with|try|catch|except|finally|def|class|fn|func|function)\b/;
const ATTRIBUTE_START = /^(?:@[A-Za-z_$]|#!?\[)/;
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

function drawBudget(
	c: Candidate,
	chars: number,
	budget: WorkBudget,
	scope = "",
): boolean {
	const key = `${scope}${c.from.index}|${c.to.index}|${c.fromStart}|${c.toStart}|${c.length}`;
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

function oddCount(text: string, pattern: RegExp): boolean {
	return (text.match(pattern) ?? []).length % 2 === 1;
}

function opensConstruct(
	run: Run,
	start: number,
	end: number,
	last: string,
): boolean {
	const rows = run.raw.slice(start, end);
	if (isProseFile(run.filename))
		return oddCount(rows.join("\n"), /^\s*(?:```|~~~)/gm);
	const text = rows.map((row) => stripComment(row, run)).join("\n");
	if ([/(?<!\\)`/g, /"""/g, /'''/g].some((re) => oddCount(text, re)))
		return true;
	const head = last.trim();
	if (ATTRIBUTE_START.test(head)) return true;
	return (
		!run.indentSensitive && CONTROL_START.test(head) && !/[;}]$/.test(head)
	);
}

/** True when the statement ending at line `end` of the run may carry on (see the matching v2 spec for the tests). */
export function leavesStatementOpen(
	run: Run,
	start: number,
	end: number,
): boolean {
	const last = lastPresentLine(run, start, end);
	if (last === "") return false;
	if (!bracketsBalance(run, start, end)) return true;
	if (opensConstruct(run, start, end, last)) return true;
	const code = stripComment(last, run).trimEnd();
	if (OPEN_ENDING.test(code)) return true;
	const next = end < run.raw.length ? run.raw[end] : run.after;
	const text = next?.trim() ?? "";
	if (text === "") return false;
	if (indentOf(next as string) > indentOf(last)) return true;
	if (CLOSER_START.test(text)) return false;
	if (startsMidStatement(text, run)) return true;
	if (listsItems(run)) return false;
	return CONTINUING_START.test(text) || !TERMINATOR.test(code);
}

/**
 * Decides whether an exact run is a block worth reporting. Five or more counted lines draw
 * one candidate (and need unique text within one file). One to four lines draw a candidate
 * and their characters, and need 30 characters of information (50 within one file) or a
 * whole definition of 40, uniqueness, no line over 2000 characters, no mid-statement start
 * and `leavesStatementOpen` false on both sides.
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
	if (c.from.literalRisk || c.to.literalRisk) return false;
	if (lines.some((line) => line.length > MAX_ANALYZED_LINE)) return false;
	const chars = nonSpace(lines.join(""));
	if (ctx.budget && !drawBudget(c, chars, ctx.budget)) return false;
	if (isOpenSingleLine(c, lines)) return false;
	if (startsMidStatement(lines.find((l) => l.trim() !== "") ?? "", c.from))
		return false;
	if (
		leavesStatementOpen(c.from, c.fromStart, c.fromStart + c.length) ||
		leavesStatementOpen(c.to, c.toStart, c.toStart + (c.toLength ?? c.length))
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

const MIN_DEFINITION_LINES = 3;
const PROSE_FILE = /\.(md|mdx|txt|rst|adoc)$/i;
const PROPERTY_LINE =
	/^(?:\.\.\.\S.*|["']?[\w$-]+["']?\??:(?:\s.*)?|[\w$]+|[{[(]+|[}\])]+[,;)]*)$/;
const IMPORT_CLOSER = /^[})\]]\s*from\b/;
const BARE_NAME = /^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?,?$/;

function bracketBalance(text: string): number {
	return (
		(text.match(/[({[]/g) ?? []).length - (text.match(/[)}\]]/g) ?? []).length
	);
}

/** Whether every line is part of an object literal body: a property, a spread, a shorthand name or a bracket. */
function onlyProperties(lines: string[]): boolean {
	return lines.every((line) => {
		const text = line.trim().replace(/,$/, "");
		return text === "" || PROPERTY_LINE.test(text);
	});
}

/** Whether the brackets outside string literals close exactly within the lines, never closing before they open. */
function bracketsClose(lines: string[]): boolean {
	let depth = 0;
	for (const line of lines) {
		depth += bracketBalance(line.replace(LITERAL, " "));
		if (depth < 0) return false;
	}
	return depth === 0;
}

/** Whether any line says something beyond import syntax: statements, multi-line import lists and bare name lists carry nothing. */
function hasSubstance(lines: string[]): boolean {
	let depth = 0;
	return lines.some((line) => {
		const text = line.trim();
		if (depth > 0) {
			depth += bracketBalance(text);
			return false;
		}
		if (IMPORT_LIKE.test(text)) {
			depth = Math.max(0, bracketBalance(text));
			return false;
		}
		if (IMPORT_CLOSER.test(text) || BARE_NAME.test(text)) return false;
		return lineInformation(text) > 0;
	});
}

/**
 * Decides whether an exact duplicate is a block worth reporting as a copy: five or more counted
 * lines, or a whole definition of at least three non-blank lines that is not a `const` assignment, and in either case at least
 * one line that carries information (a block of imports, closers, bare keywords and bare name
 * lists never qualifies). Outside prose files its brackets must also close within the block and
 * it must hold more than object properties, so a slice through the middle of a call or a run of
 * test data is not a copy. A candidate that
 * passes these draws once from the budget and is rejected when either pool runs dry.
 */
export function acceptCopySeed(c: Candidate, budget: WorkBudget): boolean {
	const lines = c.from.lines.slice(c.fromStart, c.fromStart + c.length);
	const present = lines.filter((line) => line.trim() !== "").length;
	const first = lines.find((line) => line.trim() !== "") ?? "";
	const floor =
		c.counted >= MIN_COUNTED_LINES ||
		(present >= MIN_DEFINITION_LINES &&
			!first.startsWith("const ") &&
			isWholeDefinition(c));
	if (!floor) return false;
	if (!hasSubstance(lines)) return false;
	const codeShaped = bracketsClose(lines) && !onlyProperties(lines);
	if (!PROSE_FILE.test(c.to.filename) && !codeShaped) return false;
	return drawBudget(c, nonSpace(lines.join("")), budget, "copy|");
}
