const WINDOW = 3;
const MIN_ANCHOR_CHARS = 8;
const FENCE = /^\s*```[\w-]*\s*$/;
const NUMBER_PREFIX = /^\s*(\d+)\s*[|:]\s?/;

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

function stripNumberPrefixes(
	lines: string[],
	start: number,
	end: number,
): string[] {
	const numbers = lines.map((l) => Number(NUMBER_PREFIX.exec(l)?.[1] ?? NaN));
	if (lines.length === 0 || numbers.some(Number.isNaN)) return lines;
	const consecutive = numbers.every(
		(n, i) => i === 0 || n === numbers[i - 1] + 1,
	);
	const first = numbers[0];
	const last = numbers[numbers.length - 1];
	const matchesSpan =
		Math.abs(first - start) <= WINDOW && Math.abs(last - end) <= WINDOW;
	if (!consecutive || !matchesSpan) return lines;
	return lines.map((l) => l.replace(NUMBER_PREFIX, ""));
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

function absentFrom(
	lines: string[],
	from: number,
	to: number,
	fileLines: FileLines,
): boolean {
	const present = new Set(lines.map((l) => l.trim()));
	for (let n = from; n <= to; n++) {
		const text = fileLines.get(n)?.trim();
		if (text && present.has(text)) return false;
	}
	return true;
}

/** Cleans a model-written suggestion block: unwraps a code fence, drops
 * line-number prefixes, restores a lost indentation, and realigns the replaced
 * range when the suggestion repeats neighbouring file lines verbatim (widen) or
 * leaves out unchanged edge lines (narrow). Never adds lines and never judges
 * the content. Returns null only when the block cannot be placed on lines the
 * diff shows, so the caller keeps the comment without it. */
export function repairSuggestion(
	input: RepairInput,
): RepairedSuggestion | null {
	const { fileLines } = input;
	const start = input.startLine ?? input.line;
	const end = input.line;
	if (!covers(fileLines, start, end)) return null;
	if (input.suggestion.length === 0) {
		return {
			suggestion: "",
			line: end,
			startLine: input.startLine,
		};
	}

	const keepFences =
		isFence(fileLines.get(start)) || isFence(fileLines.get(end));
	const raw = input.suggestion.split("\n");
	const lines = stripNumberPrefixes(
		keepFences ? raw : stripFence(raw),
		start,
		end,
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
	} else if (s !== null && s > start && e !== null) {
		if (absentFrom(lines, start, s - 1, fileLines)) newStart = s;
	}

	if (e !== null && e > end) {
		const width = e - end;
		if (!covers(fileLines, end, e)) return null;
		const tail = lines.slice(lines.length - width);
		const verbatim = tail.every((l, i) =>
			sameLine(l, fileLines.get(end + 1 + i)),
		);
		if (lines.length > width && verbatim) newEnd = e;
	} else if (e !== null && e < end && s !== null) {
		if (absentFrom(lines, e + 1, end, fileLines)) newEnd = e;
	}

	if (newStart > newEnd) {
		newStart = start;
		newEnd = end;
	}
	if (!covers(fileLines, newStart, newEnd)) return null;

	const target = leadingWhitespace(fileLines.get(newStart) ?? "");
	const firstText = lines.find((l) => l.trim() !== "") ?? "";
	const indented =
		target !== "" && leadingWhitespace(firstText) === ""
			? lines.map((l) => (l.trim() === "" ? l : target + l))
			: lines;

	return {
		suggestion: indented.join("\n"),
		line: newEnd,
		startLine: newStart === newEnd ? null : newStart,
	};
}
