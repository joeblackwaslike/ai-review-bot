import { isIndentSensitive, normalizeCodeLine } from "../moved-blocks.js";

const UNSAFE_LEXEME = /`|"""|'''|<</;
const BROKEN_CONTINUATION = /\\\s+$/;

/** Whether trailing whitespace after a backslash would break a line continuation. */
export function hasBrokenContinuation(line: string): boolean {
	return BROKEN_CONTINUATION.test(line);
}

/**
 * Whether whitespace-insensitive comparison of these lines cannot hide a token change.
 * Deliberately coarse: any unknown lexical context (indentation-sensitive file, template
 * literal, triple-quoted string, heredoc) means the lines must be compared raw.
 */
export function lexicallySafe(
	filename: string,
	lines: readonly string[],
): boolean {
	return (
		!isIndentSensitive(filename) &&
		!lines.some(
			(line) => UNSAFE_LEXEME.test(line) || hasBrokenContinuation(line),
		)
	);
}

/** Whitespace-collapsed lines when `lexicallySafe`, the raw lines otherwise. */
export function normalizeSafe(
	filename: string,
	lines: readonly string[],
): string[] {
	return lexicallySafe(filename, lines)
		? lines.map((line) => normalizeCodeLine(line))
		: [...lines];
}

/** Longest line, in characters, that the matcher tokenizes or scans with a literal-aware pattern. */
export const MAX_ANALYZED_LINE = 2000;

const TOKEN =
	/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S/g;
const PROSE_FILE = /\.(md|mdx|txt|rst|adoc)$/i;

/** True for documentation and plain-text files, where lines end in sentences rather than statements. */
export function isProseFile(filename: string): boolean {
	return PROSE_FILE.test(filename);
}

/** Tokens of the first `MAX_ANALYZED_LINE` characters of a line. */
export function tokens(line: string): string[] {
	return line.slice(0, MAX_ANALYZED_LINE).match(TOKEN) ?? [];
}

/** Jaccard similarity of the token sets of two lines, from 0 to 1. */
export function similarity(a: string, b: string): number {
	const left = new Set(tokens(a));
	const right = new Set(tokens(b));
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	const union = left.size + right.size - shared;
	return union === 0 ? 0 : shared / union;
}
