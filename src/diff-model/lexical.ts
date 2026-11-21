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

const REGEX_FAMILY = new Set([
	"js",
	"ts",
	"jsx",
	"tsx",
	"mjs",
	"cjs",
	"rb",
	"swift",
	"pl",
	"awk",
]);
const NON_LITERAL_UNSAFE = /`|"""|'''|<<[-~]?\s*["']?\w/;
const CONTROL_KEYWORD = /\b(?:if|while|for|with)\b/;
const SLASH_ALWAYS_AMBIGUOUS = new Set(["rb", "pl", "awk"]);
const RUBY_PERCENT_LITERAL = /%[rqQwWiIxs]\W/;
const PERL_QUOTE_LIKE = /\b(?:m|qr|s|tr|y)\s*[{([<|!#]/;
const EXPRESSION_KEYWORDS = new Set([
	"return",
	"typeof",
	"case",
	"in",
	"of",
	"delete",
	"void",
	"throw",
	"yield",
	"await",
	"else",
	"do",
	"instanceof",
	"new",
]);

function extension(filename: string): string {
	const name = filename.split("/").pop() ?? filename;
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function slashIsDivision(before: string): boolean {
	const prev = before.trimEnd();
	if (prev === "") return false;
	const last = prev[prev.length - 1] as string;
	if (last === ")") return !CONTROL_KEYWORD.test(before);
	if (last === "]") return true;
	if (!/[\w$]/.test(last)) return false;
	const word = /[\w$]+$/.exec(prev)?.[0] ?? "";
	return !EXPRESSION_KEYWORDS.has(word);
}

function lineHasRegexAmbiguity(line: string): boolean {
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
			if (j >= line.length) return true;
			i = j;
		} else if (ch === "/") {
			const next = line[i + 1];
			if (next === "/") return false;
			if (next === "*") {
				const close = line.indexOf("*/", i + 2);
				if (close < 0) return true;
				i = close + 1;
			} else if (!slashIsDivision(line.slice(0, i))) {
				return true;
			}
		}
	}
	return false;
}

function withoutStrings(line: string): string | null {
	let out = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (ch !== '"' && ch !== "'") {
			out += ch;
			continue;
		}
		let j = i + 1;
		while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
		if (j >= line.length) return null;
		out += " ";
		i = j;
	}
	return out;
}

function hasUnsafeQuoteLike(line: string, ext: string): boolean {
	const bare = withoutStrings(line);
	if (bare === null || bare.includes("/")) return true;
	if (ext === "rb") return RUBY_PERCENT_LITERAL.test(bare);
	return ext === "pl" && PERL_QUOTE_LIKE.test(bare);
}

/**
 * Whether these lines contain no backtick, triple quote, heredoc or slash that could open a
 * regex literal. Slashes are only ambiguous in the regex-literal language family, and
 * there only when not clearly division or a closed comment.
 */
export function literalSafe(
	lines: readonly string[],
	filename: string,
): boolean {
	if (lines.some((line) => NON_LITERAL_UNSAFE.test(line))) return false;
	const ext = extension(filename);
	if (!REGEX_FAMILY.has(ext)) return true;
	if (SLASH_ALWAYS_AMBIGUOUS.has(ext)) {
		return !lines.some((line) => hasUnsafeQuoteLike(line, ext));
	}
	return !lines.some(lineHasRegexAmbiguity);
}

/**
 * Each non-empty line with its indentation minus the block's smallest indent, as that many
 * spaces; null when any indentation contains a tab.
 */
export function relativeIndent(
	lines: readonly string[],
): { shape: string[]; base: number } | null {
	const indents: number[] = [];
	for (const line of lines) {
		if (line.trim() === "") continue;
		if (/^[ \t]*\S/.exec(line) === null) return null;
		const lead = /^[ ]*/.exec(line)?.[0] ?? "";
		if (/^[ ]*\t/.test(line)) return null;
		indents.push(lead.length);
	}
	const base = indents.length ? Math.min(...indents) : 0;
	return {
		base,
		shape: lines.map((line) =>
			line.trim() === ""
				? ""
				: " ".repeat((/^ */.exec(line)?.[0].length ?? 0) - base) +
					line.trimStart(),
		),
	};
}
