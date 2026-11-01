const WINDOW = 3;
const MIN_ANCHOR_LENGTH = 3;
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

function stripFence(lines: string[]): string[] {
	if (
		lines.length >= 2 &&
		FENCE.test(lines[0]) &&
		FENCE.test(lines[lines.length - 1])
	) {
		return lines.slice(1, -1);
	}
	return lines;
}

function stripNumberPrefixes(lines: string[]): string[] {
	const numbers = lines.map((l) => NUMBER_PREFIX.exec(l)?.[1]);
	if (lines.length === 0 || numbers.some((n) => n === undefined)) return lines;
	const consecutive = numbers.every(
		(n, i) => i === 0 || Number(n) === Number(numbers[i - 1]) + 1,
	);
	if (!consecutive) return lines;
	return lines.map((l) => l.replace(NUMBER_PREFIX, ""));
}

function indentOf(text: string): number {
	return text.length - text.trimStart().length;
}

function tokens(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[a-z_]\w*/g) ?? []);
}

function isAnchor(text: string): boolean {
	return text.trim().length >= MIN_ANCHOR_LENGTH;
}

/** Nearest line within the window whose text equals `text` (trimmed). The
 * current position wins; a tie between two distances leaves it unmoved. */
function findMatch(
	text: string,
	current: number,
	fileLines: Map<number, string>,
): number | null {
	const wanted = text.trim();
	if (!isAnchor(wanted)) return null;
	for (let d = 0; d <= WINDOW; d++) {
		const hits = (d === 0 ? [current] : [current - d, current + d]).filter(
			(n) => fileLines.get(n)?.trim() === wanted,
		);
		if (hits.length === 1) return hits[0];
		if (hits.length > 1) return null;
	}
	return null;
}

function overlapsRange(
	lines: string[],
	start: number,
	end: number,
	fileLines: Map<number, string>,
): boolean {
	const own = tokens(lines.join("\n"));
	if (own.size === 0) return true;
	const original: string[] = [];
	for (let n = start - WINDOW; n <= end + WINDOW; n++) {
		const text = fileLines.get(n);
		if (text !== undefined) original.push(text);
	}
	const known = tokens(original.join("\n"));
	return [...own].some((t) => known.has(t));
}

function reindent(lines: string[], target: number): string[] {
	const first = lines.find((l) => l.trim().length > 0);
	if (first === undefined || indentOf(first) >= target) return lines;
	const pad = " ".repeat(target - indentOf(first));
	return lines.map((l) => (l.trim().length > 0 ? pad + l : l));
}

/** Cleans a model-written suggestion block: unwraps a code fence, drops
 * line-number prefixes, realigns the replaced range to the file lines the
 * suggestion actually starts and ends on (within 3 lines), and restores a lost
 * indentation. Never adds lines. Returns null when the suggestion cannot be
 * tied to the file, so the caller keeps the comment without the block. */
export function repairSuggestion(
	input: RepairInput,
): RepairedSuggestion | null {
	const { fileLines } = input;
	if (input.suggestion.length === 0) {
		return {
			suggestion: input.suggestion,
			line: input.line,
			startLine: input.startLine,
		};
	}
	const lines = stripNumberPrefixes(stripFence(input.suggestion.split("\n")));
	if (lines.length === 0 || lines.every((l) => l.trim() === "")) return null;

	const start = input.startLine ?? input.line;
	let newStart = start;
	let newEnd = input.line;
	const first = findMatch(lines[0], start, fileLines);
	const last = findMatch(lines[lines.length - 1], input.line, fileLines);
	if (first !== null) newStart = first;
	if (last !== null) newEnd = last;
	if (newStart > newEnd) {
		newStart = start;
		newEnd = input.line;
	}

	const rangeText = fileLines.get(newStart);
	if (rangeText === undefined || !fileLines.has(newEnd)) return null;
	if (first === null && last === null) {
		if (!overlapsRange(lines, start, input.line, fileLines)) return null;
	}

	return {
		suggestion: reindent(lines, indentOf(rangeText)).join("\n"),
		line: newEnd,
		startLine: newStart === newEnd ? null : newStart,
	};
}
