import { MAX_ANALYZED_LINE } from "./lexical.js";

export type NewlineClass = "free" | "significant";

const BASE_OPERATORS = [
	">>>=",
	"..=",
	"<<<",
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
const GO_OPERATORS = ["<-", ...BASE_OPERATORS].sort(
	(a, b) => b.length - a.length,
);

/** The operator table for a file extension; only Go has `<-`. */
export function operatorsFor(ext: string): readonly string[] {
	return ext === "go" ? GO_OPERATORS : BASE_OPERATORS;
}

const FREE_EXTENSIONS = new Set("js ts jsx tsx mjs cjs".split(" "));
const SLASH_COMMENT_EXTENSIONS = new Set("js ts jsx tsx mjs cjs go".split(" "));
const SIBLING_COMMA_EXTENSIONS = new Set("py pyi go".split(" "));
const BLOCK_SCALAR = /[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/;
const F_PREFIX_DQ = /(?<![\p{L}\p{N}_])(?:[rR][fF]|[fF][rR]?)"/u;
const F_PREFIX_SQ = /(?<![\p{L}\p{N}_])(?:[rR][fF]|[fF][rR]?)'/u;
const NEST_DQ = /\{[^{}]*"/;
const NEST_SQ = /\{[^{}]*'/;
const JS_FAMILY = new Set("js ts jsx tsx mjs cjs".split(" "));
const QUOTE_SWAP_EXTENSIONS = new Set("js ts mjs cjs py pyi".split(" "));
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
	"public",
	"private",
	"protected",
	"readonly",
	"override",
	"accessor",
	"using",
]);
const ODD_BREAK =
	/[\r\v\f\u0085\u2028\u2029\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
const HTML_COMMENT = /<!--|-->/;
const IDENTIFIER = /[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*/uy;
const NUMBER = /0[xXoObB]\w*|\d[\d_]*(?:\.(?!\.)[\d_]*)?(?:[eE][+-]?\d+)?\w*/y;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const GROUPERS = new Set(["(", "["]);
const GROUP_CLOSERS = new Set([")", "]"]);
const ASI_HAZARDS = new Set(["(", "[", "`", "+", "-", "/", "++", "--"]);
const STATEMENT_END = /^(?:[\p{L}\p{N}_$"'`]|\)|\]|\}|\+\+|--)/u;
const EMPTY_BODY_KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"with",
	"await",
]);
const WRAP_PREV = new Set(
	", ( [ { ; } => = . ?. ? : && || ?? + - * / % < > <= >= == === != !== & | ^ ~ ! += -= *= /= %= &= |= ^= <<= >>= >>>= &&= ||= ??= **= ** << >> >>>".split(
		" ",
	),
);
const WRAP_NEXT = new Set(
	") ] } . ?. , ; ? : => + - * / % < > <= >= == === != !== & | ^ && || ?? { in instanceof ** << >> >>>".split(
		" ",
	),
);
const KEEP_SEMICOLON_AFTER = new Set(["else", ":", "=>"]);

function extension(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Whether a line holds text the token pass cannot compare reliably: over the analysis cap,
 * an odd line terminator or non-ASCII whitespace other than one trailing carriage return,
 * an HTML-like comment marker in a JS-family file, or a nested Python f-string quote.
 */
export function opaqueLine(line: string, filename: string): boolean {
	if (line.length > MAX_ANALYZED_LINE) return true;
	const text = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (ODD_BREAK.test(text)) return true;
	const ext = extension(filename);
	if (JS_FAMILY.has(ext)) return HTML_COMMENT.test(text);
	return (ext === "py" || ext === "pyi") && nestsFStringQuote(text);
}

function nestsFStringQuote(line: string): boolean {
	for (const [prefix, nested] of [
		[F_PREFIX_DQ, NEST_DQ],
		[F_PREFIX_SQ, NEST_SQ],
	] as const) {
		const found = prefix.exec(line);
		if (found && nested.test(line.slice(found.index + found[0].length)))
			return true;
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
	const ext = extension(filename);
	const slash = SLASH_COMMENT_EXTENSIONS.has(ext);
	const operators = operatorsFor(ext);
	const python = PYTHON_FILE.test(filename);
	const out: string[] = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i] as string;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (python && ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string)))
			break;
		if (slash && line.startsWith("//", i)) break;
		if (slash && line.startsWith("/*", i)) {
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
		const op = operators.find((o) => line.startsWith(o, i)) ?? ch;
		out.push(op);
		i += op.length;
	}
	return out;
}

/**
 * Splits source lines into tokens (identifiers, numbers, whole strings, longest-match
 * operators), dropping comments. `lineOf[k]` is the index in `lines` of token `k`. A JS or TS
 * file keeps a "\n" token between lines unless the break is obviously a wrap (the previous
 * token opens, separates or continues an expression, or the next one closes or continues
 * it), and always after a restricted-production keyword or before a statement-continuing
 * line under automatic semicolon insertion. Significant files emit a "\n" token between
 * logical lines (grouped by bracket depth).
 */
export function tokenize(
	lines: readonly string[],
	filename: string,
): { tokens: string[]; lineOf: number[] } {
	const free = newlineClass(filename) === "free";
	const jsFamily = JS_FAMILY.has(extension(filename));
	const braceBlocks = extension(filename) === "go";
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
		const before = tokens[tokens.length - 1];
		if (
			free &&
			first !== undefined &&
			before !== undefined &&
			before !== "\n" &&
			(BREAK_KEYWORDS.has(before) ||
				!(WRAP_PREV.has(before) || WRAP_NEXT.has(first)))
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
		const breaks = free ? BREAK_KEYWORDS.has(last) : !grouped();
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

function keepsSemicolon(tokens: string[], at: number, shape: Shape): boolean {
	return (
		KEEP_SEMICOLON_AFTER.has(tokens[at - 1] ?? "") ||
		endsEmptyBody(tokens, at, shape)
	);
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
	return shape.sibling[i] === true && SIBLING_COMMA_EXTENSIONS.has(ext);
}

/**
 * Removes formatting-only differences from a token stream: a trailing comma (JS and TS drop
 * any comma not after an opener or another comma, Python and Go only after a sibling comma),
 * a semicolon directly before `}` in the JS family unless it follows `else`, a label or `=>`
 * or ends an empty if, for, while, switch, with or for-await body, and a single-quoted string
 * in JS, TS or Python whose content has no quote, backslash or interpolation marker.
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
			if (next === "}" && !keepsSemicolon(tokens, i, shape)) return;
		}
		if (swapQuotes && swappable(t, python)) {
			out.push(`"${t.slice(1, -1)}"`);
			return;
		}
		out.push(t);
	});
	return out;
}
