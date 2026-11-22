import {
	type Candidate,
	isIndentSensitive,
	normalizeCodeLine,
	type Run,
} from "../moved-blocks.js";
import type { WorkBudget } from "./budget.js";
import { INDENT_COLLAPSIBLE_FILE } from "./file-kinds.js";
import {
	hasOddBreak,
	lexicallySafe,
	MAX_ANALYZED_LINE,
	normalizeSafe,
	similarity,
	tokens,
} from "./lexical.js";
import {
	continuesNext,
	lineDepths,
	receiverChangeClass,
	statementBoundary,
} from "./reshape.js";
import type { Divergence, DivergenceClass, Span } from "./types.js";

const MAX_DIVERGENCES = 3;
const MAX_DIVERGENCE_SHARE = 0.2;
const EDGE_SIMILARITY = 0.5;
const MIN_COUNTED_LENGTH = 3;
const MIN_RENAME_OCCURRENCES = 2;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const HASH_COMMENT_FILE =
	/(?:\.(?:py|pyi|sh|bash|zsh|rb|ya?ml|toml|mk)|(?:^|\/)Makefile)$/i;
const SLASH_LINE_FILE =
	/\.(?:tsx?|jsx?|mjs|cjs|java|c|h|cpp|cc|hpp|cs|go|rs|swift|kts?|dart|php|scala)$/i;
const SLASH_BLOCK_FILE = new RegExp(
	`${SLASH_LINE_FILE.source.slice(0, -2)}|css|scss|less)$`,
	"i",
);
const RESERVED = new Set(
	`true false null undefined None True False nil NaN Infinity let const var function return if else for while do in of
	await async yield new this self super public private protected static class interface enum type import export from
	default switch case break continue try catch finally throw typeof instanceof void delete with and or not is as def
	lambda pass del global nonlocal raise except elif end then begin unless until module struct fn mut pub impl trait
	use mod match loop where abstract extends implements final readonly package int string number boolean`.split(
		/\s+/,
	),
);

interface RawDivergence {
	kind: Divergence["kind"];
	baseIndex?: number;
	headIndex?: number;
}

export interface Built {
	renamed: number;
	fromStart: number;
	fromEnd: number;
	toStart: number;
	toEnd: number;
	divergences: Divergence[];
	counted: number;
	limit: number;
}

function isMeaningful(line: string): boolean {
	return line.trim().length >= MIN_COUNTED_LENGTH;
}

/**
 * Longest-common-subsequence alignment. Returns the matched index pairs in order.
 * A common prefix and suffix are matched first so only the differing middle is tabulated.
 */
function alignLines(
	base: string[],
	head: string[],
	budget: WorkBudget,
): [number, number][] {
	const pairs: [number, number][] = [];
	let lo = 0;
	while (lo < base.length && lo < head.length && base[lo] === head[lo]) {
		pairs.push([lo, lo]);
		lo++;
	}
	let baseEnd = base.length;
	let headEnd = head.length;
	const suffix: [number, number][] = [];
	while (
		baseEnd > lo &&
		headEnd > lo &&
		base[baseEnd - 1] === head[headEnd - 1]
	) {
		baseEnd--;
		headEnd--;
		suffix.push([baseEnd, headEnd]);
	}
	const n = baseEnd - lo;
	const m = headEnd - lo;
	if (n > 0 && m > 0 && budget.spendCells((n + 1) * (m + 1))) {
		const width = m + 1;
		const table = new Uint32Array((n + 1) * width);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				table[i * width + j] =
					base[lo + i] === head[lo + j]
						? (table[(i + 1) * width + j + 1] as number) + 1
						: Math.max(
								table[(i + 1) * width + j] as number,
								table[i * width + j + 1] as number,
							);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (base[lo + i] === head[lo + j]) {
				pairs.push([lo + i, lo + j]);
				i++;
				j++;
			} else if (
				(table[(i + 1) * width + j] as number) >=
				(table[i * width + j + 1] as number)
			) {
				i++;
			} else {
				j++;
			}
		}
	}
	return [...pairs, ...suffix.reverse()];
}

function divergencesBetween(
	baseLength: number,
	headLength: number,
	matches: [number, number][],
): RawDivergence[] {
	const out: RawDivergence[] = [];
	let baseNext = 0;
	let headNext = 0;
	const flushGap = (baseTo: number, headTo: number) => {
		const gap = Math.max(baseTo - baseNext, headTo - headNext);
		for (let k = 0; k < gap; k++) {
			const baseIndex = baseNext + k < baseTo ? baseNext + k : undefined;
			const headIndex = headNext + k < headTo ? headNext + k : undefined;
			const kind =
				baseIndex === undefined
					? "inserted"
					: headIndex === undefined
						? "removed"
						: "changed";
			out.push({ kind, baseIndex, headIndex });
		}
	};
	for (const [i, j] of matches) {
		flushGap(i, j);
		baseNext = i + 1;
		headNext = j + 1;
	}
	flushGap(baseLength, headLength);
	return out;
}

const HEREDOC_OR_TRIPLE = /"""|'''|<<[-~]?\s*['"]?\w/;

function backtickCount(line: string): number {
	return (line.match(/(?<!\\)`/g) ?? []).length;
}

/**
 * Per line, whether a whitespace change there could alter a runtime value: the line touches a
 * multi-line template literal, or the file has heredocs, triple-quoted strings or
 * significant indentation (then every line counts).
 */
function riskyLines(filename: string, lines: string[]): boolean[] {
	if (
		isIndentSensitive(filename) ||
		lines.some(
			(l) => HEREDOC_OR_TRIPLE.test(l) || hasOddBreak(l) || continuesString(l),
		)
	)
		return lines.map(() => true);
	let inside = false;
	return lines.map((line) => {
		const startsInside = inside;
		if (backtickCount(line) % 2 === 1) inside = !inside;
		return startsInside || inside;
	});
}

/** Whether a line ends in an unescaped backslash, or holds an odd count of unescaped double quotes: a string or macro that may continue on the next line. */
export function continuesString(line: string): boolean {
	const text = line.trimEnd();
	let slashes = 0;
	while (slashes < text.length && text[text.length - 1 - slashes] === "\\")
		slashes++;
	if (slashes % 2 === 1) return true;
	return (line.replace(/\\./g, "").match(/"/g) ?? []).length % 2 === 1;
}

/**
 * Per line, whether it opens, sits inside or closes a multi-line string. Text there is data
 * that only looks like a comment or a name, so such a line is never comment-only or a rename.
 * Every line of the block is marked when any line holds a heredoc or triple-quote opener, an
 * odd break, a backtick beside a quote or slash, a continued string, or when the block has more
 * than one backtick pair or a backtick left open.
 */
export function literalLines(lines: string[]): boolean[] {
	const ticks = (line: string) => line.split("`").length - 1;
	const total = lines.reduce((sum, line) => sum + ticks(line), 0);
	const risky = lines.some(
		(line) =>
			HEREDOC_OR_TRIPLE.test(line) ||
			hasOddBreak(line) ||
			continuesString(line) ||
			(ticks(line) > 0 && /["'/]/.test(line)),
	);
	if (risky || total > 2 || total === 1) return lines.map(() => true);
	let inside = false;
	return lines.map((line) => {
		const startsInside = inside;
		if (ticks(line) % 2 === 1) inside = !inside;
		return startsInside || inside;
	});
}

/** Per line, whether it is wholly a comment: `//` or `#` lines, or lines of a `/* ... *\/` block opened in these lines. */
function commentLines(filename: string, lines: string[]): boolean[] {
	const slashLine = SLASH_LINE_FILE.test(filename);
	const block = SLASH_BLOCK_FILE.test(filename);
	const hash = HASH_COMMENT_FILE.test(filename);
	let inBlock = false;
	return lines.map((line) => {
		const trimmed = line.trim();
		if (inBlock) {
			const close = trimmed.indexOf("*/");
			if (close < 0) return true;
			inBlock = false;
			return trimmed.slice(close + 2).trim() === "";
		}
		if (slashLine && trimmed.startsWith("//")) return true;
		if (hash && trimmed.startsWith("#")) return true;
		if (!block || !trimmed.startsWith("/*")) return false;
		const close = trimmed.indexOf("*/", 2);
		if (close < 0) {
			inBlock = true;
			return true;
		}
		return trimmed.slice(close + 2).trim() === "";
	});
}

const QUOTE_CHARS = new Set(['"', "'", "`"]);

/**
 * Index of a `//` that starts a trailing comment, or -1: outside string literals and either at
 * the start of the line or right after whitespace, so a `//` inside a regex literal or glued to
 * code is code. An unterminated quote hides the rest of the line.
 */
export function commentStart(line: string): number {
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = "";
		} else if (QUOTE_CHARS.has(ch)) quote = ch;
		else if (
			ch === "/" &&
			line[i + 1] === "/" &&
			(i === 0 || /\s/.test(line[i - 1] as string))
		)
			return i;
	}
	return -1;
}

function stripLineComment(line: string): string {
	const at = commentStart(line);
	return normalizeCodeLine(at < 0 ? line : line.slice(0, at));
}

/** The part before a trailing comment holds no quote and no slash, so no regex or string can hide the comment start. */
function plainCode(line: string): boolean {
	const at = commentStart(line);
	return !/['"`/]/.test(at < 0 ? line : line.slice(0, at));
}

function isCommentOnly(
	divergence: RawDivergence,
	baseComment: boolean,
	headComment: boolean,
	baseText: string | undefined,
	headText: string | undefined,
	trailing: boolean,
): boolean {
	if (divergence.kind === "removed") return baseComment;
	if (divergence.kind === "inserted") return headComment;
	const base = baseText as string;
	const head = headText as string;
	if (baseComment && headComment) return true;
	return (
		trailing &&
		commentStart(base) + commentStart(head) !== -2 &&
		plainCode(base) &&
		plainCode(head) &&
		stripLineComment(base) === stripLineComment(head)
	);
}

function afterMemberAccess(tokens: string[], at: number): boolean {
	const one = tokens[at - 1];
	const two = tokens[at - 2];
	return (
		one === "." || (one === ">" && two === "-") || (one === ":" && two === ":")
	);
}

function substitutions(base: string, head: string): [string, string][] | null {
	const left = tokens(base);
	const right = tokens(head);
	if (left.length !== right.length) return null;
	const out: [string, string][] = [];
	for (let k = 0; k < left.length; k++) {
		const a = left[k] as string;
		const b = right[k] as string;
		if (a === b) continue;
		if (!IDENTIFIER.test(a) || !IDENTIFIER.test(b)) return null;
		if (RESERVED.has(a) || RESERVED.has(b)) return null;
		if (afterMemberAccess(left, k) || afterMemberAccess(right, k)) return null;
		out.push([a, b]);
	}
	return out;
}

function renameIndexes(
	changed: { at: number; base: string; head: string }[],
	baseLines: string[],
	headLines: string[],
): Map<number, string[]> {
	const oversized = (line: string) => line.length > MAX_ANALYZED_LINE;
	if (baseLines.some(oversized) || headLines.some(oversized)) return new Map();
	const perChange = changed.map((c) => substitutions(c.base, c.head));
	const target = new Map<string, Set<string>>();
	const source = new Map<string, Set<string>>();
	const seen = new Map<string, number>();
	for (const subs of perChange) {
		for (const [from, to] of subs ?? []) {
			if (!target.has(from)) target.set(from, new Set());
			target.get(from)?.add(to);
			if (!source.has(to)) source.set(to, new Set());
			source.get(to)?.add(from);
			seen.set(from, (seen.get(from) ?? 0) + 1);
		}
	}
	const baseTokens = new Map<string, number>();
	for (const line of baseLines)
		for (const token of tokens(line))
			baseTokens.set(token, (baseTokens.get(token) ?? 0) + 1);
	const headTokens = new Set(headLines.flatMap(tokens));
	const consistent = (from: string) => {
		const to = [...(target.get(from) ?? [])];
		return (
			to.length === 1 &&
			source.get(to[0] as string)?.size === 1 &&
			!baseTokens.has(to[0] as string) &&
			!headTokens.has(from) &&
			(seen.get(from) ?? 0) >= MIN_RENAME_OCCURRENCES &&
			seen.get(from) === baseTokens.get(from)
		);
	};
	const out = new Map<number, string[]>();
	changed.forEach((c, k) => {
		const subs = perChange[k];
		if (subs && subs.length > 0 && subs.every(([from]) => consistent(from))) {
			out.set(
				c.at,
				subs.map(([from]) => from),
			);
		}
	});
	return out;
}

export function span(
	filename: string,
	side: Span["side"],
	startLine: number,
	endLine: number,
): Span {
	return { filename, side, startLine, endLine, shown: "full" };
}

function lineSpan(
	run: Run,
	side: Span["side"],
	blockStart: number,
	index: number,
): Span {
	const line = run.startLine + blockStart + index;
	return span(run.filename, side, line, line);
}

function adjacentEdge(
	from: Run,
	fromIndex: number,
	to: Run,
	toIndex: number,
): boolean {
	const a = from.raw[fromIndex];
	const b = to.raw[toIndex];
	return (
		a !== undefined &&
		b !== undefined &&
		!from.used[fromIndex] &&
		!to.used[toIndex] &&
		isMeaningful(a) &&
		isMeaningful(b) &&
		similarity(a, b) >= EDGE_SIMILARITY
	);
}

function identicalEdge(
	from: Run,
	fromIndex: number,
	to: Run,
	toIndex: number,
): boolean {
	const a = from.raw[fromIndex];
	const b = to.raw[toIndex];
	return (
		a !== undefined &&
		b !== undefined &&
		!from.used[fromIndex] &&
		!to.used[toIndex] &&
		a.trim() !== "" &&
		comparable(from.filename, [a])[0] === comparable(to.filename, [b])[0]
	);
}

function collapsible(filename: string, lines: readonly string[]): boolean {
	return (
		INDENT_COLLAPSIBLE_FILE.test(filename) &&
		lexicallySafe(filename, lines) &&
		!lines.some(continuesString)
	);
}

function comparable(filename: string, lines: readonly string[]): string[] {
	return collapsible(filename, lines)
		? normalizeSafe(filename, lines)
		: [...lines];
}

interface EdgeStep {
	base: number;
	head: number;
	cost: number;
}

function unusedLine(run: Run, index: number): boolean {
	return run.raw[index] !== undefined && !run.used[index];
}

/**
 * How far one edge of a block can grow by one step. An identical pair is free, a similar
 * pair costs one divergence, and when `canSpend` a single removed or inserted line may be
 * skipped if the lines after it are identical, so a guard at the edge of a moved block is
 * kept inside the block as a divergence instead of cutting the block short.
 */
function edgeStep(
	from: Run,
	to: Run,
	fromIndex: number,
	toIndex: number,
	dir: -1 | 1,
	canSpend: boolean,
): EdgeStep | null {
	if (identicalEdge(from, fromIndex, to, toIndex))
		return { base: 1, head: 1, cost: 0 };
	if (!canSpend) return null;
	if (adjacentEdge(from, fromIndex, to, toIndex))
		return { base: 1, head: 1, cost: 1 };
	if (
		unusedLine(from, fromIndex) &&
		identicalEdge(from, fromIndex + dir, to, toIndex)
	)
		return { base: 2, head: 1, cost: 1 };
	if (
		unusedLine(to, toIndex) &&
		identicalEdge(from, fromIndex, to, toIndex + dir)
	)
		return { base: 1, head: 2, cost: 1 };
	return null;
}

function limitFor(blockLines: number): number {
	return Math.min(
		MAX_DIVERGENCES,
		Math.floor(MAX_DIVERGENCE_SHARE * blockLines),
	);
}

/**
 * Widens a chain of seeds into one block and aligns its two sides. `fromSide` names the file
 * version the source lines belong to: "base" for deleted lines, "head" for a copy's source.
 */
export function build(
	chain: Candidate[],
	withEdges: boolean,
	budget: WorkBudget,
	onlyRisky = false,
	fromSide: Span["side"] = "base",
): Built {
	const first = chain[0] as Candidate;
	const last = chain[chain.length - 1] as Candidate;
	const { from, to } = first;
	let fromStart = first.fromStart;
	let toStart = first.toStart;
	let fromEnd = last.fromStart + last.length;
	let toEnd = last.toStart + last.length;
	if (withEdges) {
		const budget = limitFor(Math.max(fromEnd - fromStart, toEnd - toStart));
		let spent = 0;
		for (const dir of [-1, 1] as const) {
			for (;;) {
				const edge = dir < 0 ? [fromStart - 1, toStart - 1] : [fromEnd, toEnd];
				const step = edgeStep(
					from,
					to,
					edge[0] as number,
					edge[1] as number,
					dir,
					spent < budget,
				);
				if (!step) break;
				if (dir < 0) {
					fromStart -= step.base;
					toStart -= step.head;
				} else {
					fromEnd += step.base;
					toEnd += step.head;
				}
				spent += step.cost;
			}
		}
	}
	const baseRaw = from.raw.slice(fromStart, fromEnd);
	const headRaw = to.raw.slice(toStart, toEnd);
	const safe =
		collapsible(from.filename, baseRaw) && collapsible(to.filename, headRaw);
	const baseCmp = safe ? normalizeSafe(from.filename, baseRaw) : baseRaw;
	const headCmp = safe ? normalizeSafe(to.filename, headRaw) : headRaw;
	const baseRisky = riskyLines(from.filename, baseRaw);
	const headRisky = riskyLines(to.filename, headRaw);
	const baseComment = commentLines(from.filename, baseRaw);
	const headComment = commentLines(to.filename, headRaw);
	const baseLiteral = literalLines(baseRaw);
	const headLiteral = literalLines(headRaw);
	const aligned = divergencesBetween(
		baseRaw.length,
		headRaw.length,
		alignLines(baseCmp, headCmp, budget),
	);
	const raw = onlyRisky
		? aligned.filter(
				(d) =>
					(d.baseIndex !== undefined && baseRisky[d.baseIndex]) ||
					(d.headIndex !== undefined && headRisky[d.headIndex]),
			)
		: aligned;
	const text = (lines: string[], index?: number) =>
		index === undefined ? undefined : (lines[index] as string);
	const inLiteral = (d: RawDivergence) =>
		(d.baseIndex !== undefined && baseLiteral[d.baseIndex] === true) ||
		(d.headIndex !== undefined && headLiteral[d.headIndex] === true);
	const changed = raw.flatMap((d, at) =>
		d.kind === "changed" && !inLiteral(d)
			? [
					{
						at,
						base: text(baseRaw, d.baseIndex) as string,
						head: text(headRaw, d.headIndex) as string,
					},
				]
			: [],
	);
	const renames = renameIndexes(changed, baseRaw, headRaw);
	const trailing =
		SLASH_LINE_FILE.test(from.filename) && SLASH_LINE_FILE.test(to.filename);
	const baseDepths = lineDepths(baseRaw, from.filename);
	let counted = 0;
	const renamedNames = new Set<string>();
	const divergences = raw.map((d, at): Divergence => {
		const baseText = text(baseRaw, d.baseIndex);
		const headText = text(headRaw, d.headIndex);
		const cls: DivergenceClass =
			!inLiteral(d) &&
			isCommentOnly(
				d,
				d.baseIndex !== undefined && baseComment[d.baseIndex] === true,
				d.headIndex !== undefined && headComment[d.headIndex] === true,
				baseText,
				headText,
				trailing,
			)
				? "comment-only"
				: renames.has(at)
					? "rename"
					: (d.kind === "changed" &&
							receiverChangeClass(
								baseText as string,
								headText as string,
								from.filename,
								to.filename,
								statementBoundary(baseRaw, baseDepths, d.baseIndex as number) &&
									!continuesNext(headRaw, d.headIndex as number),
							)) ||
						"code";
		if (cls === "rename")
			for (const name of renames.get(at) ?? []) renamedNames.add(name);
		if (
			cls !== "receiver" &&
			[baseText, headText].some((t) => t !== undefined && isMeaningful(t))
		)
			counted++;
		const out: Divergence = { kind: d.kind, class: cls };
		if (d.baseIndex !== undefined)
			out.base = lineSpan(from, fromSide, fromStart, d.baseIndex);
		if (d.headIndex !== undefined)
			out.head = lineSpan(to, "head", toStart, d.headIndex);
		if (baseText !== undefined) out.original = baseText.trim();
		return out;
	});
	return {
		renamed: renamedNames.size,
		fromStart,
		fromEnd,
		toStart,
		toEnd,
		divergences,
		counted,
		limit: limitFor(Math.max(baseRaw.length, headRaw.length)),
	};
}

/** Groups the seeds of one run pair into chains that are close enough to widen into one block. */
export function chainSeeds(seeds: Candidate[]): Candidate[][] {
	const chains: Candidate[][] = [];
	for (const seed of [...seeds].sort((a, b) => a.fromStart - b.fromStart)) {
		const target = chains.find((chain) => {
			const last = chain[chain.length - 1] as Candidate;
			const fromGap = seed.fromStart - (last.fromStart + last.length);
			const toGap = seed.toStart - (last.toStart + last.length);
			return (
				fromGap >= 0 &&
				toGap >= 0 &&
				Math.max(fromGap, toGap) <= MAX_DIVERGENCES &&
				gapIsFree(last, seed)
			);
		});
		if (target) target.push(seed);
		else chains.push([seed]);
	}
	return chains;
}

function gapIsFree(last: Candidate, next: Candidate): boolean {
	const fromEnd = last.fromStart + last.length;
	const toEnd = last.toStart + last.length;
	for (let i = fromEnd; i < next.fromStart; i++)
		if (last.from.used[i]) return false;
	for (let j = toEnd; j < next.toStart; j++) if (last.to.used[j]) return false;
	return true;
}
