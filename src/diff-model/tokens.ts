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
const TUPLE_EXTENSIONS = new Set(
	"py pyi go rs kt kts swift scala dart groovy".split(" "),
);
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
]);
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const NUMBER = /\d(?:\w|\.(?=\d))*/y;
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
	const openers = free ? OPENERS : GROUPERS;
	const closers = free ? CLOSERS : GROUP_CLOSERS;
	const tokens: string[] = [];
	const lineOf: number[] = [];
	let depth = 0;
	lines.forEach((line, index) => {
		const found = scanLine(line, filename);
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
			if (openers.has(t)) depth++;
			else if (closers.has(t)) depth = Math.max(0, depth - 1);
		}
		const last = found[found.length - 1];
		if (last === undefined) return;
		const breaks = free
			? BREAK_KEYWORDS.has(last) || (preprocessor && /^\s*#/.test(line))
			: depth === 0;
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

function hasSiblingComma(tokens: string[], comma: number): boolean {
	let depth = 0;
	for (let k = comma - 1; k >= 0; k--) {
		const t = tokens[k] as string;
		if (CLOSERS.has(t)) depth++;
		else if (OPENERS.has(t)) {
			if (depth === 0) return false;
			depth--;
		} else if (t === "," && depth === 0) return true;
	}
	return false;
}

function endsEmptyBody(tokens: string[], semicolon: number): boolean {
	if (tokens[semicolon - 1] !== ")") return false;
	let depth = 0;
	for (let k = semicolon - 1; k >= 0; k--) {
		const t = tokens[k] as string;
		if (t === ")") depth++;
		else if (t === "(" && --depth === 0)
			return EMPTY_BODY_KEYWORDS.has(tokens[k - 1] ?? "");
	}
	return false;
}

function droppableComma(
	tokens: string[],
	i: number,
	filename: string,
): boolean {
	const ext = extension(filename);
	const jsFamily = JS_FAMILY.has(ext);
	const next = tokens[i + 1];
	if (next === undefined || !CLOSERS.has(next)) return false;
	if (!jsFamily) return TUPLE_EXTENSIONS.has(ext) && hasSiblingComma(tokens, i);
	const prev = tokens[i - 1];
	return prev !== undefined && prev !== "," && !OPENERS.has(prev);
}

/**
 * Removes formatting-only differences from a token stream: a trailing comma that does
 * not change meaning (see `droppableComma`), a trailing semicolon (JS/TS family) unless
 * it ends an empty loop or branch body, and single-quoted strings in JS/TS/Python whose
 * content has no quote, backslash or interpolation marker.
 */
export function normalizeTokens(tokens: string[], filename: string): string[] {
	const jsFamily = JS_FAMILY.has(extension(filename));
	const python = PYTHON_FILE.test(filename);
	const swapQuotes = QUOTE_SWAP_EXTENSIONS.has(extension(filename));
	const out: string[] = [];
	tokens.forEach((t, i) => {
		if (t === "," && droppableComma(tokens, i, filename)) return;
		if (jsFamily && t === ";") {
			const next = tokens[i + 1];
			if (next === "}" && !endsEmptyBody(tokens, i)) return;
		}
		if (swapQuotes && swappable(t, python)) {
			out.push(`"${t.slice(1, -1)}"`);
			return;
		}
		out.push(t);
	});
	return out;
}
