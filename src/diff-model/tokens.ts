export type NewlineClass = "free" | "significant";

export const OPERATORS: readonly string[] = [
	">>>=",
	"===",
	"!==",
	"<<=",
	">>=",
	">>>",
	"**=",
	"&&=",
	"||=",
	"??=",
	"//=",
	"...",
	"<=>",
	"=>",
	"->",
	"::",
	"++",
	"--",
	"**",
	"//",
	"&&",
	"||",
	"??",
	"?.",
	"==",
	"!=",
	"<=",
	">=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"<<",
	">>",
	":=",
	"..",
];

const SORTED_OPERATORS = [...OPERATORS].sort((a, b) => b.length - a.length);
const FREE_EXTENSIONS = new Set(
	"js ts jsx tsx mjs cjs java c h cpp hpp cs rs php css".split(" "),
);
const JS_FAMILY = new Set("js ts jsx tsx mjs cjs".split(" "));
const HASH_COMMENT_FILE = /\.(py|pyi|sh|bash|zsh|rb|ya?ml|toml|mk)$/i;
const PYTHON_FILE = /\.pyi?$/i;
const STRING_PREFIX = /^[rbfuRBFU]{1,2}$/;
const BREAK_KEYWORDS = new Set([
	"return",
	"throw",
	"break",
	"continue",
	"yield",
]);
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const NUMBER = /\d(?:\w|\.(?=\d))*/y;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

function extension(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** Whether line breaks carry no meaning in this file's language. */
export function newlineClass(filename: string): NewlineClass {
	return FREE_EXTENSIONS.has(extension(filename)) ? "free" : "significant";
}

function stringEnd(line: string, start: number, quote: string): number {
	let j = start + 1;
	while (j < line.length && line[j] !== quote) j += line[j] === "\\" ? 2 : 1;
	return Math.min(j + 1, line.length);
}

function matchAt(re: RegExp, line: string, i: number): string | undefined {
	re.lastIndex = i;
	return re.exec(line)?.[0];
}

function scanLine(line: string, filename: string): string[] {
	const hash = HASH_COMMENT_FILE.test(filename);
	const python = PYTHON_FILE.test(filename);
	const out: string[] = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i] as string;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (hash && ch === "#") break;
		if (!hash && line.startsWith("//", i)) break;
		if (line.startsWith("/*", i)) {
			const close = line.indexOf("*/", i + 2);
			if (close < 0) break;
			i = close + 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const end = stringEnd(line, i, ch);
			out.push(line.slice(i, end));
			i = end;
			continue;
		}
		const ident = matchAt(IDENTIFIER, line, i);
		if (ident) {
			const next = line[i + ident.length];
			if (
				python &&
				STRING_PREFIX.test(ident) &&
				(next === '"' || next === "'")
			) {
				const end = stringEnd(line, i + ident.length, next);
				out.push(line.slice(i, end));
				i = end;
				continue;
			}
			out.push(ident);
			i += ident.length;
			continue;
		}
		const num = matchAt(NUMBER, line, i);
		if (num) {
			out.push(num);
			i += num.length;
			continue;
		}
		const op = SORTED_OPERATORS.find((o) => line.startsWith(o, i)) ?? ch;
		out.push(op);
		i += op.length;
	}
	return out;
}

/**
 * Splits source lines into tokens (identifiers, numbers, whole strings, longest-match
 * operators), dropping comments. `lineOf[k]` is the index in `lines` of token `k`. Free
 * files drop line breaks except after return/throw/break/continue/yield; significant
 * files emit a "\n" token between logical lines (grouped by bracket depth).
 */
export function tokenize(
	lines: readonly string[],
	filename: string,
): { tokens: string[]; lineOf: number[] } {
	const free = newlineClass(filename) === "free";
	const tokens: string[] = [];
	const lineOf: number[] = [];
	let depth = 0;
	lines.forEach((line, index) => {
		const found = scanLine(line, filename);
		for (const t of found) {
			tokens.push(t);
			lineOf.push(index);
			if (OPENERS.has(t)) depth++;
			else if (CLOSERS.has(t)) depth = Math.max(0, depth - 1);
		}
		const last = found[found.length - 1];
		if (last === undefined) return;
		const breaks = free ? BREAK_KEYWORDS.has(last) : depth === 0;
		if (breaks) {
			tokens.push("\n");
			lineOf.push(index);
		}
	});
	if (tokens[tokens.length - 1] === "\n" && !free) {
		tokens.pop();
		lineOf.pop();
	}
	return { tokens, lineOf };
}

function swappable(token: string, python: boolean): boolean {
	if (token.length < 2 || !token.startsWith("'") || !token.endsWith("'"))
		return false;
	const body = token.slice(1, -1);
	if (/["'\\]|\$\{/.test(body)) return false;
	return !(python && /[{}]/.test(body));
}

/**
 * Removes formatting-only differences from a token stream: a comma before a closing
 * bracket, a trailing semicolon (JS/TS family), and single-quoted strings in JS/TS/Python
 * whose content has no quote, backslash or interpolation marker.
 */
export function normalizeTokens(tokens: string[], filename: string): string[] {
	const ext = extension(filename);
	const jsFamily = JS_FAMILY.has(ext);
	const python = PYTHON_FILE.test(filename);
	const out: string[] = [];
	tokens.forEach((t, i) => {
		const next = tokens[i + 1];
		if (t === "," && next !== undefined && CLOSERS.has(next)) return;
		if (
			jsFamily &&
			t === ";" &&
			(next === undefined || next === "\n" || next === "}")
		)
			return;
		if ((jsFamily || python) && swappable(t, python)) {
			out.push(`"${t.slice(1, -1)}"`);
			return;
		}
		out.push(t);
	});
	return out;
}
