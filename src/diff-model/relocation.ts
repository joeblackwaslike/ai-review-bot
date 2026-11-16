import {
	type Candidate,
	collectRuns,
	isIndentSensitive,
	lineCommentIndex,
	normalizeCodeLine,
	type PushFile,
	type Run,
	selectMatches,
} from "../moved-blocks.js";
import { lexicallySafe, normalizeSafe } from "./lexical.js";
import type { Divergence, DivergenceClass, Operation, Span } from "./types.js";

const MIN_MEANINGFUL_LINES = 5;
const MAX_DIVERGENCES = 3;
const MAX_DIVERGENCE_SHARE = 0.2;
const EDGE_SIMILARITY = 0.5;
const MIN_COUNTED_LENGTH = 3;
const MAX_ALIGNMENT_CELLS = 16_000_000;
const MIN_RENAME_OCCURRENCES = 2;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const TOKEN =
	/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S/g;
const HASH_COMMENT_FILE = /\.(py|pyi|sh|bash|zsh|rb|ya?ml|toml|mk)$/i;

interface RawDivergence {
	kind: Divergence["kind"];
	baseIndex?: number;
	headIndex?: number;
}

interface Built {
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

function tokens(line: string): string[] {
	return line.match(TOKEN) ?? [];
}

function similarity(a: string, b: string): number {
	const left = new Set(tokens(a));
	const right = new Set(tokens(b));
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	const union = left.size + right.size - shared;
	return union === 0 ? 0 : shared / union;
}

/**
 * Longest-common-subsequence alignment. Returns the matched index pairs in order.
 * A common prefix and suffix are matched first so only the differing middle is tabulated.
 */
function alignLines(base: string[], head: string[]): [number, number][] {
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
	if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_ALIGNMENT_CELLS) {
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
		lines.some((l) => HEREDOC_OR_TRIPLE.test(l))
	)
		return lines.map(() => true);
	let inside = false;
	return lines.map((line) => {
		const startsInside = inside;
		if (backtickCount(line) % 2 === 1) inside = !inside;
		return startsInside || inside;
	});
}

/** Per line, whether it is wholly a comment: `//` or `#` lines, or lines of a `/* ... *\/` block opened in these lines. */
function commentLines(filename: string, lines: string[]): boolean[] {
	let inBlock = false;
	return lines.map((line) => {
		const trimmed = line.trim();
		if (inBlock) {
			const close = trimmed.indexOf("*/");
			if (close < 0) return true;
			inBlock = false;
			return trimmed.slice(close + 2).trim() === "";
		}
		if (trimmed.startsWith("//")) return true;
		if (HASH_COMMENT_FILE.test(filename) && trimmed.startsWith("#"))
			return true;
		if (!trimmed.startsWith("/*")) return false;
		const close = trimmed.indexOf("*/", 2);
		if (close < 0) {
			inBlock = true;
			return true;
		}
		return trimmed.slice(close + 2).trim() === "";
	});
}

function stripLineComment(line: string): string {
	const at = lineCommentIndex(line);
	return normalizeCodeLine(at < 0 ? line : line.slice(0, at));
}

function isCommentOnly(
	divergence: RawDivergence,
	baseComment: boolean,
	headComment: boolean,
	baseText: string | undefined,
	headText: string | undefined,
): boolean {
	if (divergence.kind === "removed") return baseComment;
	if (divergence.kind === "inserted") return headComment;
	const base = baseText as string;
	const head = headText as string;
	if (baseComment && headComment) return true;
	return (
		lineCommentIndex(base) + lineCommentIndex(head) !== -2 &&
		stripLineComment(base) === stripLineComment(head)
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
		if (left[k - 1] === "." || right[k - 1] === ".") return null;
		out.push([a, b]);
	}
	return out;
}

function renameIndexes(
	changed: { at: number; base: string; head: string }[],
	baseLines: string[],
): Set<number> {
	const perChange = changed.map((c) => substitutions(c.base, c.head));
	const target = new Map<string, Set<string>>();
	const seen = new Map<string, number>();
	for (const subs of perChange) {
		for (const [from, to] of subs ?? []) {
			if (!target.has(from)) target.set(from, new Set());
			target.get(from)?.add(to);
			seen.set(from, (seen.get(from) ?? 0) + 1);
		}
	}
	const blockCount = new Map<string, number>();
	for (const line of baseLines) {
		for (const token of tokens(line)) {
			if (seen.has(token))
				blockCount.set(token, (blockCount.get(token) ?? 0) + 1);
		}
	}
	const consistent = (from: string) =>
		target.get(from)?.size === 1 &&
		(seen.get(from) ?? 0) >= MIN_RENAME_OCCURRENCES &&
		seen.get(from) === blockCount.get(from);
	const out = new Set<number>();
	changed.forEach((c, k) => {
		const subs = perChange[k];
		if (subs && subs.length > 0 && subs.every(([from]) => consistent(from)))
			out.add(c.at);
	});
	return out;
}

function span(
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

function limitFor(blockLines: number): number {
	return Math.min(
		MAX_DIVERGENCES,
		Math.floor(MAX_DIVERGENCE_SHARE * blockLines),
	);
}

function build(
	chain: Candidate[],
	withEdges: boolean,
	onlyRisky = false,
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
		while (
			spent < budget &&
			adjacentEdge(from, fromStart - 1, to, toStart - 1)
		) {
			fromStart--;
			toStart--;
			spent++;
		}
		while (spent < budget && adjacentEdge(from, fromEnd, to, toEnd)) {
			fromEnd++;
			toEnd++;
			spent++;
		}
	}
	const baseRaw = from.raw.slice(fromStart, fromEnd);
	const headRaw = to.raw.slice(toStart, toEnd);
	const safe =
		lexicallySafe(from.filename, baseRaw) &&
		lexicallySafe(to.filename, headRaw);
	const baseCmp = safe ? normalizeSafe(from.filename, baseRaw) : baseRaw;
	const headCmp = safe ? normalizeSafe(to.filename, headRaw) : headRaw;
	const baseRisky = riskyLines(from.filename, baseRaw);
	const headRisky = riskyLines(to.filename, headRaw);
	const baseComment = commentLines(from.filename, baseRaw);
	const headComment = commentLines(to.filename, headRaw);
	const aligned = divergencesBetween(
		baseRaw.length,
		headRaw.length,
		alignLines(baseCmp, headCmp),
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
	const changed = raw.flatMap((d, at) =>
		d.kind === "changed"
			? [
					{
						at,
						base: text(baseRaw, d.baseIndex) as string,
						head: text(headRaw, d.headIndex) as string,
					},
				]
			: [],
	);
	const renames = renameIndexes(changed, baseRaw);
	let counted = 0;
	const divergences = raw.map((d, at): Divergence => {
		const baseText = text(baseRaw, d.baseIndex);
		const headText = text(headRaw, d.headIndex);
		if ([baseText, headText].some((t) => t !== undefined && isMeaningful(t)))
			counted++;
		const cls: DivergenceClass = isCommentOnly(
			d,
			d.baseIndex !== undefined && baseComment[d.baseIndex] === true,
			d.headIndex !== undefined && headComment[d.headIndex] === true,
			baseText,
			headText,
		)
			? "comment-only"
			: renames.has(at)
				? "rename"
				: "code";
		const out: Divergence = { kind: d.kind, class: cls };
		if (d.baseIndex !== undefined)
			out.base = lineSpan(from, "base", fromStart, d.baseIndex);
		if (d.headIndex !== undefined)
			out.head = lineSpan(to, "head", toStart, d.headIndex);
		if (baseText !== undefined) out.original = baseText.trim();
		return out;
	});
	return {
		fromStart,
		fromEnd,
		toStart,
		toEnd,
		divergences,
		counted,
		limit: limitFor(Math.max(baseRaw.length, headRaw.length)),
	};
}

function chainSeeds(seeds: Candidate[]): Candidate[][] {
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

function toOperation(from: Run, to: Run, built: Built): Operation {
	const codeDivergences = built.divergences.filter(
		(d) => d.class === "code",
	).length;
	return {
		id: "",
		type: "relocation",
		from: [
			span(
				from.filename,
				"base",
				from.startLine + built.fromStart,
				from.startLine + built.fromEnd - 1,
			),
		],
		to: [
			span(
				to.filename,
				"head",
				to.startLine + built.toStart,
				to.startLine + built.toEnd - 1,
			),
		],
		exact: built.divergences.length === 0,
		divergences: built.divergences,
		reviewWeight: codeDivergences,
	};
}

function claim(from: Run, to: Run, built: Built): void {
	for (let i = built.fromStart; i < built.fromEnd; i++) from.used[i] = true;
	for (let j = built.toStart; j < built.toEnd; j++) to.used[j] = true;
}

function resolveChain(chain: Candidate[]): Operation[] {
	const { from, to } = chain[0] as Candidate;
	const whole = build(chain, true);
	if (whole.counted <= whole.limit) {
		claim(from, to, whole);
		return [toOperation(from, to, whole)];
	}
	if (chain.length > 1) return chain.flatMap((seed) => resolveChain([seed]));
	const plain = build(chain, false, true);
	claim(from, to, plain);
	return [toOperation(from, to, plain)];
}

/**
 * Finds blocks of at least 5 meaningful lines that were deleted from one file and added to
 * another, tolerating a few changed, inserted or removed lines inside the block. Exact runs
 * seed each block; the block is then widened over the lines between and next to the seeds,
 * its two sides are aligned, and every line that does not align becomes a divergence
 * classed as comment-only, rename or code. A block that would need more than 3 differing
 * lines or 20 percent of its length is reported as its exact runs only. Lines are compared
 * raw wherever whitespace-insensitive comparison is not known to be safe.
 */
export function findRelocations(files: PushFile[]): Operation[] {
	const { deleted, added } = collectRuns(files);
	const seeds = selectMatches(deleted, added, MIN_MEANINGFUL_LINES);
	const groups = new Map<string, Candidate[]>();
	for (const seed of seeds) {
		const key = `${seed.from.index}|${seed.to.index}`;
		groups.set(key, [...(groups.get(key) ?? []), seed]);
	}
	const chains = [...groups.values()].flatMap(chainSeeds);
	chains.sort(
		(a, b) =>
			size(b) - size(a) ||
			(a[0] as Candidate).from.index - (b[0] as Candidate).from.index,
	);
	const operations = chains.flatMap(resolveChain);
	operations.sort(
		(a, b) =>
			compareText(a.from[0]?.filename, b.from[0]?.filename) ||
			(a.from[0]?.startLine ?? 0) - (b.from[0]?.startLine ?? 0) ||
			compareText(a.to[0]?.filename, b.to[0]?.filename) ||
			(a.to[0]?.startLine ?? 0) - (b.to[0]?.startLine ?? 0),
	);
	return operations.map((op, k) => ({ ...op, id: `relocation-${k + 1}` }));
}

function size(chain: Candidate[]): number {
	return chain.reduce((sum, seed) => sum + seed.counted, 0);
}

function compareText(a: string | undefined, b: string | undefined): number {
	return (a ?? "").localeCompare(b ?? "");
}
