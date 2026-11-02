const WINDOW = 3;
const MIN_ANCHOR_CHARS = 8;
const FENCE = /^\s*```[\w-]*\s*$/;
const COLON_NUMBER_PREFIX = /^\s*(\d+)\s*:\s?/;
const PIPE_NUMBER_PREFIX = /^\s*(\d+)\s*\|\s?/;
const NUMERIC_KEY = /^\s*\d+\s*:/;

interface RepairInput {
	suggestion: string;
	line: number;
	startLine: number | null;
	fileLines: Map<number, string>;
}

export interface RepairedSuggestion {
	suggestion: string;
	line: number;
	startLine: number | null;
}

type FileLines = Map<number, string>;

function isFence(text: string | undefined): boolean {
	return text !== undefined && FENCE.test(text);
}

function stripFence(lines: string[]): string[] {
	if (lines.length >= 2 && isFence(lines[0]) && isFence(lines.at(-1))) {
		return lines.slice(1, -1);
	}
	return lines;
}

/** Drops `N |` and `N:` display prefixes. The pipe form is display-only and
 * strips when its numbers land within +-WINDOW of the replaced range. The
 * colon form is also source syntax (`1: "one",`), so it strips only when its
 * numbers land on the range exactly, and never when a replaced file line
 * itself starts with a numeric key. */
function stripNumberPrefixes(
	lines: string[],
	start: number,
	end: number,
	fileLines: FileLines,
): string[] {
	if (lines.length === 0) return lines;
	const hasNumericKeys = rangeLines(fileLines, start, end).some((l) =>
		NUMERIC_KEY.test(l),
	);
	const forms = hasNumericKeys
		? [{ prefix: PIPE_NUMBER_PREFIX, tolerance: WINDOW }]
		: [
				{ prefix: PIPE_NUMBER_PREFIX, tolerance: WINDOW },
				{ prefix: COLON_NUMBER_PREFIX, tolerance: 0 },
			];
	for (const { prefix, tolerance } of forms) {
		const numbers = lines.map((l) => Number(prefix.exec(l)?.[1] ?? NaN));
		if (numbers.some(Number.isNaN)) continue;
		const consecutive = numbers.every(
			(n, i) => i === 0 || n === numbers[i - 1] + 1,
		);
		const first = numbers[0];
		const last = numbers[numbers.length - 1];
		if (
			consecutive &&
			Math.abs(first - start) <= tolerance &&
			Math.abs(last - end) <= tolerance
		) {
			return lines.map((l) => l.replace(prefix, ""));
		}
	}
	return lines;
}

function rangeLines(fileLines: FileLines, from: number, to: number): string[] {
	const out: string[] = [];
	for (let n = from; n <= to; n++) out.push(fileLines.get(n) ?? "");
	return out;
}

function leadingWhitespace(text: string): string {
	return text.slice(0, text.length - text.trimStart().length);
}

function nonWhitespaceChars(text: string): number {
	return text.replace(/\s/g, "").length;
}

function sameLine(a: string | undefined, b: string | undefined): boolean {
	return a !== undefined && b !== undefined && a.trim() === b.trim();
}

/** Position of the file line equal to `text` near `current`. The current line
 * wins; a neighbour only counts when the text is distinctive and unambiguous. */
function findMatch(
	text: string,
	current: number,
	fileLines: FileLines,
): number | null {
	if (sameLine(fileLines.get(current), text)) return current;
	if (nonWhitespaceChars(text) < MIN_ANCHOR_CHARS) return null;
	for (let d = 1; d <= WINDOW; d++) {
		const hits = [current - d, current + d].filter((n) =>
			sameLine(fileLines.get(n), text),
		);
		if (hits.length === 1) return hits[0];
		if (hits.length > 1) return null;
	}
	return null;
}

function covers(fileLines: FileLines, from: number, to: number): boolean {
	for (let n = from; n <= to; n++) if (!fileLines.has(n)) return false;
	return true;
}

function occurrences(text: string, token: string): number {
	return text.split(token).length - 1;
}

/** Whether a string in the block runs across lines, where added indentation
 * would change the string's value. A line with an odd count of a quote token
 * opens or closes one. */
function opensMultilineLiteral(lines: string[]): boolean {
	return lines.some((l) =>
		["`", '"""', "'''"].some((token) => occurrences(l, token) % 2 === 1),
	);
}

/** Whether `line` keeps the indentation of a replaced line that is
 * distinctive: long enough to anchor and appearing once in the range. A short
 * or repeated line (`else:`, `}`) matches too easily to prove anything. */
function copiesRangeLineVerbatim(line: string, range: string[]): boolean {
	if (nonWhitespaceChars(line) < MIN_ANCHOR_CHARS) return false;
	const twins = range.filter((r) => r.trim() === line.trim());
	return (
		twins.length === 1 &&
		leadingWhitespace(twins[0]) === leadingWhitespace(line)
	);
}

/** The block with the target line's indentation restored, when it looks lost:
 * the first text line is at column 0 under an indented target, no line the
 * block copies from the replaced range keeps that line's own indentation (a
 * verbatim copy means the block was written at file indentation, so its
 * column-0 lines are a deliberate dedent), the block opens no multiline
 * string, and the result is not just the replaced lines again (then the
 * indentation change is the whole fix). */
function restoreIndentation(lines: string[], range: string[]): string[] {
	const target = leadingWhitespace(range[0] ?? "");
	const firstText = lines.find((l) => l.trim() !== "") ?? "";
	if (target === "" || leadingWhitespace(firstText) !== "") return lines;
	if (opensMultilineLiteral(lines)) return lines;
	const keepsVerbatim = lines.some(
		(l) => l.trim() !== "" && copiesRangeLineVerbatim(l, range),
	);
	if (keepsVerbatim) return lines;
	const indented = lines.map((l) => (l.trim() === "" ? l : target + l));
	return indented.join("\n") === range.join("\n") ? lines : indented;
}

/** Cleans a model-written suggestion block: unwraps a code fence, drops
 * line-number prefixes, restores a lost indentation, and widens the replaced
 * range when the suggestion repeats neighbouring file lines verbatim. It never
 * narrows the range, since an edge line the suggestion leaves out may be an
 * intended deletion. Never adds lines and never judges the content.
 *
 * Returns null when the replaced range, or the range widened to, crosses
 * lines the diff does not show, and when the block is empty or only blank
 * lines once cleaned (an empty value cannot be told from "no suggestion", and
 * GitHub would apply it as a one-click deletion). The caller then keeps the
 * comment without the block. */
export function repairSuggestion(
	input: RepairInput,
): RepairedSuggestion | null {
	const { fileLines } = input;
	const start = input.startLine ?? input.line;
	const end = input.line;
	if (start > end) return null;
	if (!covers(fileLines, start, end)) return null;

	const keepFences =
		isFence(fileLines.get(start)) || isFence(fileLines.get(end));
	const raw = input.suggestion.split("\n");
	const lines = stripNumberPrefixes(
		keepFences ? raw : stripFence(raw),
		start,
		end,
		fileLines,
	);
	if (lines.every((l) => l.trim() === "")) return null;

	const s = findMatch(lines[0], start, fileLines);
	const e = findMatch(lines[lines.length - 1], end, fileLines);
	let newStart = start;
	let newEnd = end;

	if (s !== null && s < start) {
		const width = start - s;
		if (!covers(fileLines, s, start)) return null;
		const verbatim = lines
			.slice(0, width)
			.every((l, i) => sameLine(l, fileLines.get(s + i)));
		if (lines.length > width && verbatim) newStart = s;
	}

	if (e !== null && e > end) {
		const width = e - end;
		if (!covers(fileLines, end, e)) return null;
		const tail = lines.slice(lines.length - width);
		const verbatim = tail.every((l, i) =>
			sameLine(l, fileLines.get(end + 1 + i)),
		);
		if (lines.length > width && verbatim) newEnd = e;
	}

	if (!covers(fileLines, newStart, newEnd)) return null;

	const indented = restoreIndentation(
		lines,
		rangeLines(fileLines, newStart, newEnd),
	);

	return {
		suggestion: indented.join("\n"),
		line: newEnd,
		startLine: newStart === newEnd ? null : newStart,
	};
}
