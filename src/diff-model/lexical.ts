import { isIndentSensitive, normalizeCodeLine } from "../moved-blocks.js";

const UNSAFE_LEXEME = /`|"""|'''|<</;

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
		!lines.some((line) => UNSAFE_LEXEME.test(line))
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
