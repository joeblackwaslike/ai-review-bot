import type { Candidate, PushFile, Run } from "../moved-blocks.js";
import { acceptSeed } from "./acceptance.js";
import type { WorkBudget } from "./budget.js";
import { literalSafe, relativeIndent } from "./lexical.js";
import {
	BLOCK_SCALAR,
	newlineClass,
	normalizeTokens,
	opaqueLine,
	tokenize,
	yamlOpaqueLines,
} from "./tokens.js";
import type { Operation, Span } from "./types.js";

const WINDOW = 8;
const MAX_WINDOW_OCCURRENCES = 2;
const MIN_COUNTED_LENGTH = 3;
/** The language families the token pass pairs, exposed so a test can pin them to the checker's. */
export const FAMILIES = [
	["js", "jsx", "mjs", "cjs"],
	["ts", "tsx"],
	["py", "pyi"],
	["go"],
	["yml", "yaml"],
];
const FAMILY = new Map(FAMILIES.flatMap((exts, i) => exts.map((e) => [e, i])));
const LINE_MODE = new Set(["yml", "yaml"]);
const LITERAL_OPENER = /`|"""|'''|<<[-~]?\s*['"]?\w/;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const LINE_WINDOW = 5;
const MAX_DEPTH = 200;
const JSX_FILES = new Set(["jsx", "tsx"]);
const JSX_CAPABLE = new Set(["js", "mjs", "cjs"]);
const JSX_TEXT = /<[A-Za-z][\w.-]*[\s>/]|<\/|\/>|<>/;

/**
 * Rewrites a normalized token stream before seeding: drops tokens the pass must not compare
 * and reports, per kept token, what was dropped just before it.
 */
export interface Lens {
	accepts(filename: string): boolean;
	strip(
		tokens: string[],
		lineOf: number[],
		filename: string,
	): { tokens: string[]; lineOf: number[]; dropped: string[] };
}

/** A maximal run of unclaimed lines of one file, tokenized. */
export interface Segment {
	id: number;
	window: number;
	run: Run;
	start: number;
	tokens: string[];
	lineOf: number[];
	firstToken: number[];
	lastToken: number[];
	bad: boolean[];
	dropped: string[];
}

/** Equal tokens `len` long starting at token `di` of `d` and token `ai` of `a`. */
export interface Range {
	d: Segment;
	a: Segment;
	di: number;
	ai: number;
	len: number;
}

/** A token range that matched across two segments, as run-level line indices. */
export interface Match {
	range: Range;
	dFirst: number;
	dLast: number;
	aFirst: number;
	aLast: number;
}

/** Lowercased extension of a filename, or empty. */
export function extension(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

function nonSpace(text: string): number {
	return text.replace(/\s/g, "").length;
}

function swapped(token: string): string {
	return token.startsWith("'") ? `"${token.slice(1, -1)}"` : token;
}

function normalizedLines(
	raw: string[],
	normalized: string[],
	lineOf: number[],
): number[] | null {
	const out: number[] = [];
	let p = 0;
	raw.forEach((token, i) => {
		const kept = normalized[p];
		if (kept === token || (kept !== undefined && kept === swapped(token))) {
			out.push(lineOf[i] as number);
			p++;
		}
	});
	return out.length === normalized.length ? out : null;
}

function commentBearing(
	lines: string[],
	raw: string[],
	lineOf: number[],
): boolean[] {
	const tokenChars = lines.map(() => 0);
	raw.forEach((token, i) => {
		if (token !== "\n")
			tokenChars[lineOf[i] as number] =
				(tokenChars[lineOf[i] as number] as number) + nonSpace(token);
	});
	return lines.map((line, l) => nonSpace(line) !== tokenChars[l]);
}

function lineModeTokens(lines: string[]): {
	tokens: string[];
	lineOf: number[];
} {
	const tokens: string[] = [];
	const lineOf: number[] = [];
	lines.forEach((line, l) => {
		const text = line.trim();
		if (l > 0) {
			tokens.push("\n");
			lineOf.push(lineOf[lineOf.length - 1] as number);
		}
		tokens.push(text);
		lineOf.push(l);
	});
	return { tokens, lineOf };
}

function buildSegment(
	id: number,
	run: Run,
	start: number,
	end: number,
	budget: WorkBudget,
	lens?: Lens,
): Segment | null | undefined {
	const lines = run.raw.slice(start, end);
	const ext = extension(run.filename);
	const lineMode = LINE_MODE.has(ext);
	let tokens: string[];
	let lineOf: number[] | null;
	let bad: boolean[];
	if (lineMode) {
		({ tokens, lineOf } = lineModeTokens(lines));
		if (!budget.spendTokens(tokens.length)) return undefined;
		bad = yamlOpaqueLines(lines);
	} else {
		const { tokens: raw, lineOf: rawLine } = tokenize(lines, run.filename);
		if (!budget.spendTokens(raw.length)) return undefined;
		tokens = normalizeTokens(raw, run.filename);
		lineOf = normalizedLines(raw, tokens, rawLine);
		bad = commentBearing(lines, raw, rawLine);
	}
	if (!lineOf) return null;
	bad = bad.map((b, l) => b || opaqueLine(lines[l] as string, run.filename));
	let dropped: string[] = [];
	if (lens && !lineMode)
		({ tokens, lineOf, dropped } = lens.strip(tokens, lineOf, run.filename));
	const firstToken = lines.map(() => Number.POSITIVE_INFINITY);
	const lastToken = lines.map(() => -1);
	tokens.forEach((token, k) => {
		if (token === "\n") return;
		const l = lineOf[k] as number;
		firstToken[l] = Math.min(firstToken[l] as number, k);
		lastToken[l] = k;
	});
	return {
		id,
		window: lineMode ? LINE_WINDOW : WINDOW,
		run,
		start,
		tokens,
		lineOf,
		firstToken,
		lastToken,
		bad,
		dropped,
	};
}

function buildSegments(
	runs: Run[],
	budget: WorkBudget,
	skip: ReadonlySet<string>,
	lens?: Lens,
): Segment[] | null {
	const out: Segment[] = [];
	for (const run of runs) {
		if (!FAMILY.has(extension(run.filename)) || skip.has(run.filename))
			continue;
		if (lens && !lens.accepts(run.filename)) continue;
		let i = 0;
		while (i < run.raw.length) {
			if (run.used[i]) {
				i++;
				continue;
			}
			const start = i;
			while (i < run.raw.length && !run.used[i]) i++;
			const lines = run.raw.slice(start, i);
			if (!lines.some((l) => l.trim().length >= MIN_COUNTED_LENGTH)) continue;
			const seg = buildSegment(out.length, run, start, i, budget, lens);
			if (seg === undefined) return null;
			if (seg) out.push(seg);
		}
	}
	return out;
}

interface Hit {
	seg: Segment;
	pos: number;
}

function windowIndex(segments: Segment[]): Map<string, Hit[]> {
	const index = new Map<string, Hit[]>();
	for (const seg of segments) {
		for (let pos = 0; pos + seg.window <= seg.tokens.length; pos++) {
			const key = seg.tokens.slice(pos, pos + seg.window).join("\u0001");
			const hits = index.get(key);
			if (!hits) index.set(key, [{ seg, pos }]);
			else if (hits.length <= MAX_WINDOW_OCCURRENCES) hits.push({ seg, pos });
		}
	}
	return index;
}

function widen(d: Hit, a: Hit): Range {
	let di = d.pos;
	let ai = a.pos;
	while (di > 0 && ai > 0 && d.seg.tokens[di - 1] === a.seg.tokens[ai - 1]) {
		di--;
		ai--;
	}
	let len = d.pos - di + d.seg.window;
	while (
		di + len < d.seg.tokens.length &&
		ai + len < a.seg.tokens.length &&
		d.seg.tokens[di + len] === a.seg.tokens[ai + len]
	)
		len++;
	return { d: d.seg, a: a.seg, di, ai, len };
}

function pairable(d: Segment, a: Segment): boolean {
	return (
		FAMILY.get(extension(d.run.filename)) ===
			FAMILY.get(extension(a.run.filename)) &&
		d.run.indentSensitive === a.run.indentSensitive &&
		newlineClass(d.run.filename) === newlineClass(a.run.filename) &&
		(d.run.filename !== a.run.filename || d.run.region !== a.run.region)
	);
}

function discoverRanges(deleted: Segment[], added: Segment[]): Range[] {
	const dIndex = windowIndex(deleted);
	const aIndex = windowIndex(added);
	const covered = new Map<string, number>();
	const out: Range[] = [];
	for (const [key, dHits] of dIndex) {
		const aHits = aIndex.get(key);
		if (!aHits) continue;
		if (
			dHits.length > MAX_WINDOW_OCCURRENCES ||
			aHits.length > MAX_WINDOW_OCCURRENCES
		)
			continue;
		for (const d of dHits) {
			for (const a of aHits) {
				if (!pairable(d.seg, a.seg)) continue;
				const diagonal = `${d.seg.id}|${a.seg.id}|${d.pos - a.pos}`;
				if (d.pos < (covered.get(diagonal) ?? 0)) continue;
				const range = widen(d, a);
				covered.set(diagonal, range.di + range.len);
				out.push(range);
			}
		}
	}
	return out;
}

function badAt(seg: Segment, pos: number): boolean {
	return seg.bad[seg.lineOf[pos] as number] === true;
}

function badBetween(seg: Segment, before: number, after: number): boolean {
	const from = seg.lineOf[before] as number;
	const to = seg.lineOf[after] as number;
	for (let l = from + 1; l < to; l++) if (seg.bad[l]) return true;
	return false;
}

function cutAtComments(r: Range): Range[] {
	const out: Range[] = [];
	let start = -1;
	const flush = (end: number) => {
		if (start >= 0 && end > start)
			out.push({ ...r, di: r.di + start, ai: r.ai + start, len: end - start });
		start = -1;
	};
	for (let k = 0; k < r.len; k++) {
		if (badAt(r.d, r.di + k) || badAt(r.a, r.ai + k)) {
			flush(k);
			continue;
		}
		const gap =
			k > 0 &&
			(badBetween(r.d, r.di + k - 1, r.di + k) ||
				badBetween(r.a, r.ai + k - 1, r.ai + k));
		if (gap) flush(k);
		if (start < 0) start = k;
	}
	flush(r.len);
	return out;
}

function atStart(seg: Segment, pos: number): boolean {
	return pos === 0 || seg.tokens[pos - 1] === "\n";
}

function atEnd(seg: Segment, pos: number): boolean {
	return pos === seg.tokens.length || seg.tokens[pos] === "\n";
}

function trimNewlines(r: Range): Range {
	let { di, ai, len } = r;
	while (len > 0 && r.d.tokens[di] === "\n") {
		di++;
		ai++;
		len--;
	}
	while (len > 0 && r.d.tokens[di + len - 1] === "\n") len--;
	return { ...r, di, ai, len };
}

function alignToLogicalLines(r: Range): Range {
	let { di, ai, len } = r;
	if (!(atStart(r.d, di) && atStart(r.a, ai))) {
		let k = 0;
		while (k < len && r.d.tokens[di + k] !== "\n") k++;
		k = Math.min(k + 1, len);
		di += k;
		ai += k;
		len -= k;
	}
	if (len > 0 && !(atEnd(r.d, di + len) && atEnd(r.a, ai + len))) {
		let k = len - 1;
		while (k >= 0 && r.d.tokens[di + k] !== "\n") k--;
		len = Math.max(k, 0);
	}
	return { ...r, di, ai, len };
}

function wholeLineBounds(
	seg: Segment,
	pos: number,
	len: number,
): [number, number] {
	let from = 0;
	let to = len;
	const first = seg.lineOf[pos] as number;
	const last = seg.lineOf[pos + len - 1] as number;
	if ((seg.firstToken[first] as number) < pos) {
		from = len;
		for (let k = 0; k < len; k++) {
			if ((seg.lineOf[pos + k] as number) > first) {
				from = k;
				break;
			}
		}
	}
	if ((seg.lastToken[last] as number) >= pos + len) {
		to = 0;
		for (let k = 0; k < len; k++) {
			if ((seg.lineOf[pos + k] as number) >= last) {
				to = k;
				break;
			}
		}
	}
	return [from, to];
}

function trimToWholeLines(r: Range): Range | null {
	const [dFrom, dTo] = wholeLineBounds(r.d, r.di, r.len);
	const [aFrom, aTo] = wholeLineBounds(r.a, r.ai, r.len);
	const from = Math.max(dFrom, aFrom);
	const to = Math.min(dTo, aTo);
	if (to <= from) return null;
	return { ...r, di: r.di + from, ai: r.ai + from, len: to - from };
}

function settle(start: Range): Range | null {
	const significant = newlineClass(start.d.run.filename) === "significant";
	let cur: Range | null = start;
	for (;;) {
		let next: Range | null = trimNewlines(cur);
		if (significant) next = trimNewlines(alignToLogicalLines(next));
		if (next.len < 1) return null;
		next = trimToWholeLines(next);
		if (!next) return null;
		if (next.di === cur.di && next.len === cur.len) return next;
		cur = next;
	}
}

function toMatch(r: Range): Match {
	const last = (seg: Segment, pos: number) =>
		seg.start + (seg.lineOf[pos + r.len - 1] as number);
	return {
		range: r,
		dFirst: r.d.start + (r.d.lineOf[r.di] as number),
		dLast: last(r.d, r.di),
		aFirst: r.a.start + (r.a.lineOf[r.ai] as number),
		aLast: last(r.a, r.ai),
	};
}

/** First physical line of each logical line of the token range, from the run's raw lines. */
export function logicalFirstLines(
	seg: Segment,
	pos: number,
	len: number,
): string[] {
	const lines: string[] = [];
	for (let k = 0; k < len; k++) {
		if (k === 0 || seg.tokens[pos + k - 1] === "\n")
			lines.push(
				seg.run.raw[seg.start + (seg.lineOf[pos + k] as number)] ?? "",
			);
	}
	return lines;
}

function indentShape(
	lines: string[],
): { base: number; depths: number[] } | null {
	const rel = relativeIndent(lines);
	if (!rel) return null;
	return {
		base: rel.base,
		depths: rel.shape.map((l) => l.length - l.trimStart().length),
	};
}

/**
 * The uniform indentation shift between two spans of an indentation-sensitive file, or null
 * when either span mixes tabs or the logical lines' relative depths differ. Zero when
 * indentation carries no meaning.
 */
export function indentShift(
	indentSensitive: boolean,
	baseWhole: string[],
	headWhole: string[],
	baseLogical: string[],
	headLogical: string[],
): number | null {
	if (!indentSensitive) return 0;
	if (relativeIndent(baseWhole) === null || relativeIndent(headWhole) === null)
		return null;
	const base = indentShape(baseLogical);
	const head = indentShape(headLogical);
	if (!base || !head) return null;
	if (base.depths.join(",") !== head.depths.join(",")) return null;
	return head.base - base.base;
}

function reindentShift(m: Match): number | null {
	const { d, a, di, ai, len } = m.range;
	return indentShift(
		d.run.indentSensitive,
		d.run.raw.slice(m.dFirst, m.dLast + 1),
		a.run.raw.slice(m.aFirst, m.aLast + 1),
		logicalFirstLines(d, di, len),
		logicalFirstLines(a, ai, len),
	);
}

/** Whether the token range closes every bracket it opens and never closes an unopened one. */
export function balanced(seg: Segment, pos: number, len: number): boolean {
	if (seg.window === LINE_WINDOW) return true;
	let depth = 0;
	for (let k = pos; k < pos + len; k++) {
		const t = seg.tokens[k] as string;
		if (OPENERS.has(t)) {
			if (++depth > MAX_DEPTH) return false;
		} else if (CLOSERS.has(t) && --depth < 0) return false;
	}
	return depth === 0;
}

/** A span over run-level line indices `first` to `last`, shown in full. */
export function span(
	run: Run,
	side: Span["side"],
	first: number,
	last: number,
): Span {
	return {
		filename: run.filename,
		side,
		startLine: run.startLine + first,
		endLine: run.startLine + last,
		shown: "full",
	};
}

/** Whether any line of the match is already claimed on either side. */
export function overlapsClaimed(m: Match): boolean {
	const { d, a } = m.range;
	for (let i = m.dFirst; i <= m.dLast; i++) if (d.run.used[i]) return true;
	for (let j = m.aFirst; j <= m.aLast; j++) if (a.run.used[j]) return true;
	return false;
}

/** The match as an acceptance candidate for `acceptSeed`. */
export function asCandidate(m: Match): Candidate {
	const from = m.range.d.run;
	const length = m.dLast - m.dFirst + 1;
	return {
		from,
		to: m.range.a.run,
		fromStart: m.dFirst,
		toStart: m.aFirst,
		length,
		toLength: m.aLast - m.aFirst + 1,
		counted: from.lines
			.slice(m.dFirst, m.dFirst + length)
			.filter((l) => l.trimStart().length >= MIN_COUNTED_LENGTH).length,
	};
}

function toOperation(m: Match, shift: number): Operation {
	const { d, a } = m.range;
	const op: Operation = {
		id: "",
		type: "relocation",
		from: [span(d.run, "base", m.dFirst, m.dLast)],
		to: [span(a.run, "head", m.aFirst, m.aLast)],
		exact: true,
		divergences: [],
		reviewWeight: 0,
	};
	if (shift !== 0) op.shape = { reindent: shift };
	return op;
}

/** Longest matches first, then by position. */
export function rank(a: Match, b: Match): number {
	return (
		b.range.len - a.range.len ||
		a.range.d.run.index - b.range.d.run.index ||
		a.range.a.run.index - b.range.a.run.index ||
		a.dFirst - b.dFirst ||
		a.aFirst - b.aFirst
	);
}

const COMMENTED_EXTENSIONS = new Set("js mjs cjs ts jsx tsx go".split(" "));
const QUOTED_EXTENSIONS = new Set("js mjs cjs ts jsx tsx py pyi go".split(" "));

function opensUnclosedString(file: PushFile): boolean {
	const ext = extension(file.filename);
	if (!QUOTED_EXTENSIONS.has(ext)) return false;
	const hash = ext === "py" || ext === "pyi";
	for (const row of (file.patch ?? "").split("\n")) {
		if (/^.\s*(?:\*|\/\*)/.test(row)) continue;
		let quote = "";
		for (let i = 1; i < row.length; i++) {
			const ch = row[i] as string;
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = "";
			} else if (ch === '"' || ch === "'") quote = ch;
			else if (hash ? ch === "#" : row.startsWith("//", i)) break;
		}
		if (quote && !row.endsWith("\\")) return true;
	}
	return false;
}

function blockCommentHazard(patch: string): boolean {
	let open = false;
	for (const row of patch.split("\n")) {
		if (open && /^[-+]/.test(row)) return true;
		for (const [mark] of row.matchAll(/\/\*|\*\//g)) {
			if (mark === "/*") open = true;
			else if (!open) return true;
			else open = false;
		}
	}
	return open;
}

function mayHoldJsx(file: PushFile): boolean {
	const ext = extension(file.filename);
	return (
		JSX_FILES.has(ext) ||
		(JSX_CAPABLE.has(ext) && JSX_TEXT.test(file.patch ?? ""))
	);
}

/**
 * Names of the files the token pass leaves to the line matcher: those whose visible patch
 * text holds a backtick, a triple quote, a heredoc opener or a line that opens a string
 * it does not close, a YAML block scalar header, a block comment that is unbalanced or holds a changed line, and JSX-capable files, where whitespace, commas and quotes in text
 * are content.
 */
export function filesWithLiterals(files: PushFile[]): Set<string> {
	return new Set(
		files
			.filter(
				(f) =>
					LITERAL_OPENER.test(f.patch ?? "") ||
					mayHoldJsx(f) ||
					(LINE_MODE.has(extension(f.filename)) &&
						(f.patch ?? "")
							.split("\n")
							.some((row) => BLOCK_SCALAR.test(row.trimEnd()))) ||
					opensUnclosedString(f) ||
					(COMMENTED_EXTENSIONS.has(extension(f.filename)) &&
						blockCommentHazard(f.patch ?? "")),
			)
			.map((f) => f.filename),
	);
}

/**
 * Discovers token ranges between unclaimed lines of the deleted and added runs: eight-token
 * windows seed matches, which grow to maximal ranges, are cut at comments and narrowed to
 * whole lines (and whole logical lines in line-significant languages). Longest first.
 * A lens rewrites the token streams first and restricts the files considered.
 */
export function findMatches(
	deleted: Run[],
	added: Run[],
	budget: WorkBudget,
	skip: ReadonlySet<string>,
	lens?: Lens,
): Match[] {
	const dSegments = buildSegments(deleted, budget, skip, lens);
	const aSegments = dSegments && buildSegments(added, budget, skip, lens);
	if (!dSegments || !aSegments) return [];
	return discoverRanges(dSegments, aSegments)
		.flatMap(cutAtComments)
		.map(settle)
		.filter((r): r is Range => r !== null)
		.map(toMatch)
		.sort(rank);
}

/** Whether the match's lines are unclaimed on both sides and literal-safe. */
export function claimable(m: Match): boolean {
	const { d, a } = m.range;
	return (
		!overlapsClaimed(m) &&
		literalSafe(d.run.raw.slice(m.dFirst, m.dLast + 1), d.run.filename) &&
		literalSafe(a.run.raw.slice(m.aFirst, m.aLast + 1), a.run.filename)
	);
}

/**
 * Finds exact relocations between unclaimed lines whose text differs only by formatting
 * (Prettier or Black rewraps, quote style, trailing commas) or by uniform indentation in
 * indentation-sensitive files. Eight-token windows seed matches, which grow to maximal
 * token ranges and are narrowed to whole lines (and whole logical lines in line-significant
 * languages). A line holding a comment or a token outside the range stays unclaimed.
 * Each match must be literal-safe and pass the seed acceptance rule. Claims the matched
 * lines on both runs. Stops, keeping what it already emitted, when the budget runs out.
 */
export function findTokenOperations(
	deleted: Run[],
	added: Run[],
	budget: WorkBudget,
	skip: ReadonlySet<string> = new Set(),
): Operation[] {
	const matches = findMatches(deleted, added, budget, skip);
	const ctx = { deleted, added, budget };
	const out: Operation[] = [];
	for (const m of matches) {
		if (budget.exhausted) break;
		if (!claimable(m)) continue;
		const { d, a } = m.range;
		if (!balanced(d, m.range.di, m.range.len)) continue;
		if (!balanced(a, m.range.ai, m.range.len)) continue;
		const shift = reindentShift(m);
		if (shift === null) continue;
		if (!acceptSeed(asCandidate(m), ctx)) continue;
		for (let i = m.dFirst; i <= m.dLast; i++) d.run.used[i] = true;
		for (let j = m.aFirst; j <= m.aLast; j++) a.run.used[j] = true;
		out.push(toOperation(m, shift));
	}
	return out;
}
