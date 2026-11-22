import { isIndentSensitive, type PushFile } from "../moved-blocks.js";
import { hasBrokenContinuation } from "./lexical.js";
import type { Divergence, Operation, Span } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const TRIPLE_QUOTE = /"""|'''/g;
const HEREDOC_OPEN = /<<[-~]?\s*['"]?(\w+)/;

const HASH_FAMILY =
	/(?:\.(?:py|pyi|rb|sh|bash|zsh|ya?ml|toml|mk)|(?:^|\/)Makefile)$/i;
const C_LINE_COMMENTS =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|java|c|h|cpp|cc|hpp|cs|go|rs|swift|kt|kts|dart|php|scala)$/i;
const C_BLOCK_COMMENTS =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|java|c|h|cpp|cc|hpp|cs|go|rs|swift|kt|kts|dart|php|scala|css|scss|less)$/i;
const WORD =
	/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S/g;
const NAME = /^[A-Za-z_$][\w$]*$/;
const NOT_RENAMABLE = new Set(
	`true false null undefined None True False nil NaN Infinity let const var function return if else for while do in of
	await async yield new this self super public private protected static class interface enum type import export from
	default switch case break continue try catch finally throw typeof instanceof void delete with and or not is as def
	lambda pass del global nonlocal raise except elif end then begin unless until module struct fn mut pub impl trait
	use mod match loop where abstract extends implements final readonly package int string number boolean`.split(
		/\s+/,
	),
);
const LONGEST_RENAMABLE_LINE = 2000;

interface Side {
	filename: string;
	lines: string[];
	positions: number[];
	inLiteral: boolean[];
}

interface Entry {
	text: string;
	inLiteral: boolean;
	indentSensitive: boolean;
}

interface ChangedLines {
	deleted: Map<number, string>;
	added: Map<number, string>;
}

function changedLines(patch: string | undefined): ChangedLines {
	const out: ChangedLines = { deleted: new Map(), added: new Map() };
	let oldLine = 0;
	let newLine = 0;
	for (const row of (patch ?? "").split("\n")) {
		const header = HUNK_HEADER.exec(row);
		if (header) {
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
		} else if (row.startsWith("-")) {
			out.deleted.set(oldLine++, row.slice(1));
		} else if (row.startsWith("+")) {
			out.added.set(newLine++, row.slice(1));
		} else if (row.startsWith(" ")) {
			oldLine++;
			newLine++;
		}
	}
	return out;
}

function readSide(spans: Span[], files: PushFile[]): Side[] | null {
	const sides: Side[] = [];
	for (const span of spans) {
		const file = files.find((f) => f.filename === span.filename);
		if (!file) return null;
		const changed = changedLines(file.patch);
		const source = span.side === "base" ? changed.deleted : changed.added;
		const side: Side = {
			filename: span.filename,
			lines: [],
			positions: [],
			inLiteral: [],
		};
		for (let n = span.startLine; n <= span.endLine; n++) {
			const text = source.get(n);
			if (text === undefined) return null;
			side.lines.push(text);
			side.positions.push(n);
		}
		side.inLiteral = insideLiteral(side.lines);
		sides.push(side);
	}
	return sides;
}

function count(line: string, pattern: RegExp): number {
	return (line.match(pattern) ?? []).length;
}

/**
 * Marks each line that opens, sits inside or closes a multi-line template literal,
 * triple-quoted string or heredoc. A span whose delimiters do not balance is all marked.
 */
function insideLiteral(lines: string[]): boolean[] {
	const marks: boolean[] = [];
	let template = false;
	let triple = false;
	let heredocEnd: string | null = null;
	for (const line of lines) {
		let marked = template || triple || heredocEnd !== null;
		if (heredocEnd !== null && line.trim() === heredocEnd) heredocEnd = null;
		else if (heredocEnd === null) {
			if (count(line, /(?<!\\)`/g) % 2 === 1) {
				template = !template;
				marked = true;
			}
			if (count(line, TRIPLE_QUOTE) % 2 === 1) {
				triple = !triple;
				marked = true;
			}
			const opener = HEREDOC_OPEN.exec(line);
			if (opener) {
				heredocEnd = opener[1] as string;
				marked = true;
			}
		}
		marks.push(marked);
	}
	if (template || triple || heredocEnd !== null) return lines.map(() => true);
	return marks;
}

function claimLine(
	span: Span | undefined,
	sides: Side[],
	spent: Set<string>,
): string | null | undefined {
	if (!span) return undefined;
	if (span.startLine !== span.endLine) return null;
	const side = sides.find((s) => s.filename === span.filename);
	const at = side?.positions.indexOf(span.startLine) ?? -1;
	if (!side || at < 0) return null;
	const key = `${span.filename}:${span.startLine}`;
	if (spent.has(key)) return null;
	spent.add(key);
	return side.lines[at];
}

function supports(
	divergence: Divergence,
	base: string | null | undefined,
	head: string | null | undefined,
): boolean {
	if (base === null || head === null) return false;
	if (divergence.kind === "changed")
		return base !== undefined && head !== undefined && base !== head;
	if (divergence.kind === "removed")
		return base !== undefined && head === undefined;
	return head !== undefined && base === undefined;
}

function unclaimed(sides: Side[], spent: Set<string>): Entry[] {
	return sides.flatMap((side) =>
		side.lines.flatMap((text, i) =>
			spent.has(`${side.filename}:${side.positions[i]}`)
				? []
				: [
						{
							text,
							inLiteral: side.inLiteral[i] as boolean,
							indentSensitive: isIndentSensitive(side.filename),
						},
					],
		),
	);
}

function interior(line: string): string {
	const text = line.trim();
	return /["'`/]/.test(text) ? text : text.replace(/\s+/g, " ");
}

function pairsUp(base: Entry, head: Entry): boolean {
	if (base.text === head.text) return true;
	const safe = (entry: Entry) =>
		!entry.inLiteral &&
		!entry.indentSensitive &&
		!hasBrokenContinuation(entry.text);
	return (
		safe(base) && safe(head) && interior(base.text) === interior(head.text)
	);
}

function accountedPositionally(base: Entry[], head: Entry[]): boolean {
	return (
		base.length === head.length &&
		base.every((entry, i) => pairsUp(entry, head[i] as Entry))
	);
}

function slashStyle(filename: string): boolean {
	return C_LINE_COMMENTS.test(filename);
}

function commentStart(line: string): number {
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
		} else if (ch === "/" && line[i + 1] === "/") {
			return i;
		}
	}
	return -1;
}

function wholeCommentLines(side: Side): boolean[] {
	const lineSlashes = C_LINE_COMMENTS.test(side.filename);
	const blockSlashes = C_BLOCK_COMMENTS.test(side.filename);
	const hash = HASH_FAMILY.test(side.filename);
	let open = false;
	return side.lines.map((raw) => {
		const line = raw.trim();
		if (open) {
			const end = line.indexOf("*/");
			if (end < 0) return true;
			open = false;
			return line.slice(end + 2).trim() === "";
		}
		if (hash && line.startsWith("#")) return true;
		if (lineSlashes && line.startsWith("//")) return true;
		if (!blockSlashes || !line.startsWith("/*")) return false;
		const end = line.indexOf("*/", 2);
		if (end < 0) {
			open = true;
			return true;
		}
		return line.slice(end + 2).trim() === "";
	});
}

function codePart(line: string): string {
	const at = commentStart(line);
	return interior(at < 0 ? line : line.slice(0, at));
}

function commentOnlyHolds(
	divergence: Divergence,
	base: string | undefined,
	head: string | undefined,
	baseWhole: boolean,
	headWhole: boolean,
	slashBoth: boolean,
): boolean {
	if (divergence.kind === "removed") return baseWhole;
	if (divergence.kind === "inserted") return headWhole;
	if (base === undefined || head === undefined) return false;
	if (baseWhole && headWhole) return true;
	if (!slashBoth) return false;
	const differs = commentStart(base) >= 0 || commentStart(head) >= 0;
	return differs && codePart(base) === codePart(head);
}

function words(lines: string[]): string[] {
	return lines.flatMap((line) => line.match(WORD) ?? []);
}

function renamedPairs(base: string, head: string): [string, string][] | null {
	const left = base.match(WORD) ?? [];
	const right = head.match(WORD) ?? [];
	if (left.length !== right.length) return null;
	const pairs: [string, string][] = [];
	for (let i = 0; i < left.length; i++) {
		const a = left[i] as string;
		const b = right[i] as string;
		if (a === b) continue;
		const bothNames = NAME.test(a) && NAME.test(b);
		const free = !NOT_RENAMABLE.has(a) && !NOT_RENAMABLE.has(b);
		const member = left[i - 1] === "." || right[i - 1] === ".";
		if (!bothNames || !free || member) return null;
		pairs.push([a, b]);
	}
	return pairs;
}

function tally(items: string[], item: string): number {
	return items.filter((x) => x === item).length;
}

/**
 * Re-derives a rename claim: the renamed pairs of every claimed rename divergence must form a
 * one-to-one mapping, the new names must be absent from the base span, the old names absent
 * from the head span, and every base occurrence of an old name must sit on a claimed line.
 * Returns the number of distinct renamed identifiers, or null when the claim does not hold.
 */
function verifiedRenames(
	pairsPerLine: [string, string][][],
	baseSides: Side[],
	headSides: Side[],
): number | null {
	const baseLines = baseSides.flatMap((side) => side.lines);
	const headLines = headSides.flatMap((side) => side.lines);
	if (pairsPerLine.length === 0) return 0;
	if (
		[...baseLines, ...headLines].some((l) => l.length > LONGEST_RENAMABLE_LINE)
	)
		return null;
	const forward = new Map<string, string>();
	const backward = new Map<string, string>();
	const occurrences = new Map<string, number>();
	for (const [from, to] of pairsPerLine.flat()) {
		if (forward.get(from) !== undefined && forward.get(from) !== to)
			return null;
		if (backward.get(to) !== undefined && backward.get(to) !== from)
			return null;
		forward.set(from, to);
		backward.set(to, from);
		occurrences.set(from, (occurrences.get(from) ?? 0) + 1);
	}
	const baseWords = words(baseLines);
	const headWords = words(headLines);
	for (const [from, to] of forward) {
		const total = occurrences.get(from) ?? 0;
		if (total < 2 || tally(baseWords, to) > 0 || tally(headWords, from) > 0)
			return null;
		if (tally(baseWords, from) !== total) return null;
	}
	return forward.size;
}

function classesHold(op: Operation, base: Side[], head: Side[]): number | null {
	const wholeBase = new Map(
		base.map((s) => [s.filename, wholeCommentLines(s)]),
	);
	const wholeHead = new Map(
		head.map((s) => [s.filename, wholeCommentLines(s)]),
	);
	const whole = (
		span: Span | undefined,
		sides: Side[],
		marks: Map<string, boolean[]>,
	) => {
		const side = sides.find((s) => s.filename === span?.filename);
		const at = side?.positions.indexOf(span?.startLine ?? -1) ?? -1;
		return at >= 0 && marks.get(side?.filename as string)?.[at] === true;
	};
	let code = 0;
	const renamePairs: [string, string][][] = [];
	for (const d of op.divergences) {
		const baseText = textOf(d.base, base);
		const headText = textOf(d.head, head);
		if (d.class === "code") {
			code++;
		} else if (d.class === "comment-only") {
			const slashBoth =
				slashStyle(d.base?.filename ?? "") &&
				slashStyle(d.head?.filename ?? "");
			if (
				!commentOnlyHolds(
					d,
					baseText,
					headText,
					whole(d.base, base, wholeBase),
					whole(d.head, head, wholeHead),
					slashBoth,
				)
			)
				return null;
		} else if (d.class === "rename") {
			if (
				d.kind !== "changed" ||
				baseText === undefined ||
				headText === undefined
			)
				return null;
			const pairs = renamedPairs(baseText, headText);
			if (!pairs || pairs.length === 0) return null;
			renamePairs.push(pairs);
		} else {
			return null;
		}
	}
	const renamed = verifiedRenames(renamePairs, base, head);
	return renamed === null ? null : code + renamed;
}

function textOf(span: Span | undefined, sides: Side[]): string | undefined {
	const side = sides.find((s) => s.filename === span?.filename);
	const at = side?.positions.indexOf(span?.startLine ?? -1) ?? -1;
	return at < 0 ? undefined : side?.lines[at];
}

/**
 * Checks a relocation claim against the patches without using the matcher's alignment.
 * Every line of both spans must be an identical raw pair, a pair that differs only in
 * whitespace outside any multi-line literal of a file without significant indentation,
 * or a divergence the operation lists; a listed divergence the lines do not bear out
 * also fails the claim.
 */
export function verifyRelocation(op: Operation, files: PushFile[]): boolean {
	const base = readSide(op.from, files);
	const head = readSide(op.to, files);
	if (!base || !head) return false;
	const baseSpent = new Set<string>();
	const headSpent = new Set<string>();
	for (const divergence of op.divergences) {
		const baseLine = claimLine(divergence.base, base, baseSpent);
		const headLine = claimLine(divergence.head, head, headSpent);
		if (!supports(divergence, baseLine, headLine)) return false;
		if (
			divergence.original !== undefined &&
			baseLine !== undefined &&
			baseLine?.trim() !== divergence.original
		)
			return false;
	}
	if (op.exact && op.divergences.length > 0) return false;
	const weight = classesHold(op, base, head);
	if (weight === null || weight !== op.reviewWeight) return false;
	return accountedPositionally(
		unclaimed(base, baseSpent),
		unclaimed(head, headSpent),
	);
}
