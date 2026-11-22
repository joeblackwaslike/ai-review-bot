import { MAX_ANALYZED_LINE } from "./lexical.js";

export type NewlineClass = "free" | "significant";

export const OPERATORS: readonly string[] = [
	">>>=",
	"..=",
	"<<<",
	"<-",
	"=~",
	"!~",
	"&.",
	"|>",
	"<>",
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
	"!!",
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
].sort((a, b) => b.length - a.length);
const FREE_EXTENSIONS = new Set(
	"js ts jsx tsx mjs cjs java c h cpp hpp cs rs php css".split(" "),
);
const SLASH_COMMENT_EXTENSIONS = new Set(
	"js ts jsx tsx mjs cjs java c h cpp hpp cs rs php go kt kts swift scala dart groovy".split(
		" ",
	),
);
const BLOCK_COMMENT_EXTENSIONS = new Set([...SLASH_COMMENT_EXTENSIONS, "css"]);
const PREPROCESSOR_EXTENSIONS = new Set("c h cpp hpp cs".split(" "));
const SIBLING_COMMA_EXTENSIONS = new Set("py pyi go".split(" "));
const SIBLING_BRACE_COMMA_EXTENSIONS = new Set(
	"java c h cpp hpp cs".split(" "),
);
const BRACE_BLOCK_EXTENSIONS = new Set(
	"go kt kts swift scala dart groovy".split(" "),
);
const BLOCK_SCALAR = /[|>][+-]?\d*\s*(?:#.*)?$/;
const C_RAW = /(?<![\p{L}\p{N}_])(?:u8|[uUL])?R"/u;
const RAW_STRING: Record<string, RegExp> = {
	rs: /(?<![\p{L}\p{N}_])(?:br|cr|r)#*"/u,
	c: C_RAW,
	h: C_RAW,
	cpp: C_RAW,
	hpp: C_RAW,
	cs: /@"|\$"|"""/,
};
const F_PREFIX = /(?<![\p{L}\p{N}_])(?:[rR][fF]|[fF][rR]?)(["'])/gu;
const JS_FAMILY = new Set("js ts jsx tsx mjs cjs".split(" "));
const QUOTE_SWAP_EXTENSIONS = new Set("js ts mjs cjs py pyi".split(" "));
const HASH_COMMENT_FILE = /\.(py|pyi|sh|bash|zsh|rb|ya?ml|toml|mk)$/i;
const PYTHON_FILE = /\.pyi?$/i;
const STRING_PREFIX = /^[rbfuRBFU]{1,2}$/;
const BREAK_KEYWORDS = new Set([
	"return",
	"throw",
	"break",
	"continue",
	"yield",
	"async",
	"type",
	"declare",
	"abstract",
	"namespace",
	"module",
	"interface",
	"enum",
	"get",
	"set",
	"static",
	"let",
	"await",
]);
const ODD_BREAK = /[\r\v\f\u0085\u2028\u2029]/;
const HTML_COMMENT = /<!--|-->/;
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const NUMBER = /0[xXoObB]\w*|\d[\d_]*(?:\.(?!\.)[\d_]*)?(?:[eE][+-]?\d+)?\w*/y;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const GROUPERS = new Set(["(", "["]);
const GROUP_CLOSERS = new Set([")", "]"]);
const ASI_HAZARDS = new Set(["(", "[", "`", "+", "-", "/", "++", "--"]);
const STATEMENT_END = /^(?:[\p{L}\p{N}_$"'`]|\)|\]|\}|\+\+|--)/u;
const EMPTY_BODY_KEYWORDS = new Set(["if", "for", "while", "switch"]);

function extension(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Whether a line holds text the token pass cannot compare reliably: over the analysis cap,
 * an odd line terminator other than one trailing carriage return, an HTML-like comment
 * marker in a JS-family file, or a Python, Rust, C, C++ or C# string form the scanner
 * would split wrongly.
 */
export function opaqueLine(line: string, filename: string): boolean {
	if (line.length > MAX_ANALYZED_LINE) return true;
	const text = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (ODD_BREAK.test(text)) return true;
	const ext = extension(filename);
	if (JS_FAMILY.has(ext)) return HTML_COMMENT.test(text);
	if (ext === "py" || ext === "pyi") return nestsFStringQuote(text);
	return RAW_STRING[ext]?.test(text) ?? false;
}

function nestsFStringQuote(line: string): boolean {
	for (const found of line.matchAll(F_PREFIX)) {
		const rest = line.slice((found.index ?? 0) + found[0].length);
		if (new RegExp(`\\{[^}]*${found[1]}`).test(rest)) return true;
	}
	return false;
}

/**
 * Per line of a YAML block, whether trimmed-text comparison cannot be trusted: a block
 * scalar indicator, the scalar body, or trailing whitespace.
 */
export function yamlOpaqueLines(lines: readonly string[]): boolean[] {
	let block = -1;
	return lines.map((line) => {
		const text = line.endsWith("\r") ? line.slice(0, -1) : line;
		const indent = text.length - text.trimStart().length;
		if (block >= 0) {
			if (text.trim() === "" || indent > block) return true;
			block = -1;
		}
		if (BLOCK_SCALAR.test(text.trimEnd())) {
			block = indent;
			return true;
		}
		return text !== text.trimEnd();
	});
}

/** Whether line breaks carry no meaning in this file's language. */
export function newlineClass(filename: string): NewlineClass {
	return FREE_EXTENSIONS.has(extension(filename)) ? "free" : "significant";
}

function endsStatement(token: string | undefined): boolean {
	return token !== undefined && token !== "\n" && STATEMENT_END.test(token);
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
	const ext = extension(filename);
	const slash = SLASH_COMMENT_EXTENSIONS.has(ext);
	const block = BLOCK_COMMENT_EXTENSIONS.has(ext);
	const python = PYTHON_FILE.test(filename);
	const out: string[] = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i] as string;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (hash && ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string)))
			break;
		if (slash && line.startsWith("//", i)) break;
		if (block && line.startsWith("/*", i)) {
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
		const op = OPERATORS.find((o) => line.startsWith(o, i)) ?? ch;
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
	const jsFamily = JS_FAMILY.has(extension(filename));
	const preprocessor = PREPROCESSOR_EXTENSIONS.has(extension(filename));
	const braceBlocks = BRACE_BLOCK_EXTENSIONS.has(extension(filename));
	const openers = free || braceBlocks ? OPENERS : GROUPERS;
	const closers = free || braceBlocks ? CLOSERS : GROUP_CLOSERS;
	const tokens: string[] = [];
	const lineOf: number[] = [];
	const open: string[] = [];
	let depth = 0;
	const grouped = () =>
		braceBlocks ? open.length > 0 && open[open.length - 1] !== "{" : depth > 0;
	lines.forEach((line, index) => {
		const found =
			line.length > MAX_ANALYZED_LINE ? [line] : scanLine(line, filename);
		const first = found[0];
		if (
			jsFamily &&
			first !== undefined &&
			ASI_HAZARDS.has(first) &&
			endsStatement(tokens[tokens.length - 1])
		) {
			tokens.push("\n");
			lineOf.push(lineOf[lineOf.length - 1] as number);
		}
		for (const t of found) {
			tokens.push(t);
			lineOf.push(index);
			if (openers.has(t)) {
				depth++;
				open.push(t);
			} else if (closers.has(t)) {
				depth = Math.max(0, depth - 1);
				open.pop();
			}
		}
		const last = found[found.length - 1];
		if (last === undefined) return;
		const breaks = free
			? BREAK_KEYWORDS.has(last) || (preprocessor && /^\s*#/.test(line))
			: !grouped();
		if (breaks) {
			tokens.push("\n");
			lineOf.push(index);
		}
	});
	if (tokens[tokens.length - 1] === "\n") {
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

interface Shape {
	sibling: boolean[];
	parenOpen: number[];
}

function shapeOf(tokens: string[], python: boolean): Shape {
	const sibling = tokens.map(() => false);
	const parenOpen = tokens.map(() => -1);
	const groups = [{ seen: false, params: 0 }];
	const parens: number[] = [];
	tokens.forEach((t, k) => {
		const group = groups[groups.length - 1] as (typeof groups)[number];
		if (OPENERS.has(t)) {
			groups.push({ seen: false, params: 0 });
			if (t === "(") parens.push(k);
		} else if (CLOSERS.has(t)) {
			if (groups.length > 1) groups.pop();
			if (t === ")") parenOpen[k] = parens.pop() ?? -1;
		} else if (t === ",") {
			sibling[k] = group.seen;
			if (group.params === 0) group.seen = true;
		} else if (python && t === "lambda") group.params++;
		else if (python && t === ":" && group.params > 0) group.params--;
	});
	return { sibling, parenOpen };
}

function endsEmptyBody(tokens: string[], semicolon: number, shape: Shape) {
	if (tokens[semicolon - 1] !== ")") return false;
	const open = shape.parenOpen[semicolon - 1] ?? -1;
	return open > 0 && EMPTY_BODY_KEYWORDS.has(tokens[open - 1] ?? "");
}

function droppableComma(
	tokens: string[],
	i: number,
	filename: string,
	shape: Shape,
): boolean {
	const ext = extension(filename);
	const next = tokens[i + 1];
	if (next === undefined || !CLOSERS.has(next)) return false;
	if (JS_FAMILY.has(ext)) {
		const prev = tokens[i - 1];
		return prev !== undefined && prev !== "," && !OPENERS.has(prev);
	}
	if (shape.sibling[i] !== true) return false;
	return (
		SIBLING_COMMA_EXTENSIONS.has(ext) ||
		(SIBLING_BRACE_COMMA_EXTENSIONS.has(ext) && next === "}")
	);
}

/**
 * Removes formatting-only differences from a token stream: a trailing comma that follows
 * a sibling comma (JS and TS drop any comma not after an opener or another comma; Java, C
 * and C# only before `}`; Rust, Kotlin and Dart never), a semicolon directly before `}` in
 * the JS family unless it ends an empty if, for, while or switch body, and a single-quoted
 * string in JS, TS or Python whose content has no quote, backslash or interpolation marker.
 */
export function normalizeTokens(tokens: string[], filename: string): string[] {
	const jsFamily = JS_FAMILY.has(extension(filename));
	const python = PYTHON_FILE.test(filename);
	const swapQuotes = QUOTE_SWAP_EXTENSIONS.has(extension(filename));
	const shape = shapeOf(tokens, python);
	const out: string[] = [];
	tokens.forEach((t, i) => {
		if (t === "," && droppableComma(tokens, i, filename, shape)) return;
		if (jsFamily && t === ";") {
			const next = tokens[i + 1];
			if (next === "}" && !endsEmptyBody(tokens, i, shape)) return;
		}
		if (swapQuotes && swappable(t, python)) {
			out.push(`"${t.slice(1, -1)}"`);
			return;
		}
		out.push(t);
	});
	return out;
}
