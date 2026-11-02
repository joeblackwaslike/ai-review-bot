const WINDOW = 3;
const MIN_ANCHOR_CHARS = 8;
const FENCE = /^\s*```[\w-]*\s*$/;
const NUMBER_PREFIX = /^\s*(\d+)\s*[|:]\s?/;
const PIPE_NUMBER_PREFIX = /^\s*(\d+)\s*\|\s?/;
const NUMERIC_KEY = /^\s*\d+\s*:/;
const DICT_VALUE_LINE = /^\s*\d+\s*:\s*\S.*[,{]\s*$/;

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

/** Drops `N |` and `N:` display prefixes. When a replaced file line, or the
 * suggestion's own line, looks like a numeric map key (`1: "one",`), `N:` is
 * source syntax and only the pipe form is stripped. */
function stripNumberPrefixes(
	lines: string[],
	start: number,
	end: number,
	fileLines: FileLines,
): string[] {
	const range = rangeLines(fileLines, start, end);
	const looksLikeNumericKeys =
		range.some((l) => NUMERIC_KEY.test(l)) ||
		lines.some((l) => DICT_VALUE_LINE.test(l));
	const prefix = looksLikeNumericKeys ? PIPE_NUMBER_PREFIX : NUMBER_PREFIX;
	const numbers = lines.map((l) => Number(prefix.exec(l)?.[1] ?? NaN));
	if (lines.length === 0 || numbers.some(Number.isNaN)) return lines;
	const consecutive = numbers.every(
		(n, i) => i === 0 || n === numbers[i - 1] + 1,
	);
	const first = numbers[0];
	const last = numbers[numbers.length - 1];
	const matchesSpan =
		Math.abs(first - start) <= WINDOW && Math.abs(last - end) <= WINDOW;
	if (!consecutive || !matchesSpan) return lines;
	return lines.map((l) => l.replace(prefix, ""));
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

/** The block with the target line's indentation restored, when it looks lost:
 * the first text line is at column 0 under an indented target, no line the
 * block copies from the replaced range keeps that line's own indentation (a
 * verbatim copy means the block was written at file indentation, so its
 * column-0 lines are a deliberate dedent), and the result is not just the
 * replaced lines again (then the indentation change is the whole fix). */
function restoreIndentation(lines: string[], range: string[]): string[] {
	const target = leadingWhitespace(range[0] ?? "");
	const firstText = lines.find((l) => l.trim() !== "") ?? "";
	if (target === "" || leadingWhitespace(firstText) !== "") return lines;
	const keepsVerbatim = lines.some(
		(l) =>
			l.trim() !== "" &&
			range.some(
				(r) =>
					r.trim() === l.trim() &&
					leadingWhitespace(r) === leadingWhitespace(l),
			),
	);
	if (keepsVerbatim) return lines;
	const indented = lines.map((l) => (l.trim() === "" ? l : target + l));
	return indented.join("\n") === range.join("\n") ? lines : indented;
}

/** Cleans a model-written suggestion block: unwraps a code fence, drops
 * line-number prefixes, restores a lost indentation, and widens the replaced
 * range when the suggestion repeats neighbouring file lines verbatim. It never
 * narrows the range, since an edge line the suggestion leaves out may be an
 * intended deletion. Never adds lines and never judges the content. A block
 * that is empty or only blank lines once cleaned is posted as is on the
 * original range (a deletion or a blank-line replacement).
 *
 * Returns null only when the replaced range, or the range widened to, crosses
 * lines the diff does not show, so the caller keeps the comment without it. */
export function repairSuggestion(
	input: RepairInput,
): RepairedSuggestion | null {
	const { fileLines } = input;
	const start = input.startLine ?? input.line;
	const end = input.line;
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
	if (lines.every((l) => l.trim() === "")) {
		return {
			suggestion: lines.join("\n"),
			line: end,
			startLine: input.startLine,
		};
	}

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
