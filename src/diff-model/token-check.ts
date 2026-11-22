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

/** The checker's own operator table for an extension, exposed so a test can pin it to the matcher's. */
export function checkerOperatorsFor(ext: string): readonly string[] {
	return ext === "go" ? GO_OPERATORS : BASE_OPERATORS;
}

const FAMILIES = [
	["js", "jsx", "mjs", "cjs"],
	["ts", "tsx"],
	["py", "pyi"],
	["go"],
	["yml", "yaml"],
];

/** The checker's own language families, exposed so a test can pin them to the matcher's. */
export const CHECKER_FAMILIES: readonly (readonly string[])[] = FAMILIES;

const FAMILY_OF = new Map(
	FAMILIES.flatMap((names, i) => names.map((n) => [n, i] as const)),
);
const words = (list: string) => new Set(list.split(" "));
const LINE_MODE = words("yml yaml");
const FREE = words("js jsx mjs cjs ts tsx");
const JS_LIKE = words("js jsx mjs cjs ts tsx");
const SLASH_COMMENTS = words("js jsx mjs cjs ts tsx go");
const HASH_COMMENTS = words("py pyi");
const PYTHON = words("py pyi");
const INDENTED = words("py pyi yml yaml");
const SIBLING_COMMA = words("py pyi go");
const BRACE_BLOCKS = words("go");
const QUOTE_SWAP = words("js mjs cjs ts py pyi");
const JSX_ALWAYS = words("jsx tsx");
const JSX_POSSIBLE = words("js mjs cjs");
const BREAKING_WORDS = words(
	"return throw break continue yield async type declare abstract namespace module interface enum get set static let await public private protected readonly override accessor using",
);
const BEFORE_EXPRESSION = words(
	"return typeof case in of delete void throw yield await else do instanceof new default",
);
const WRAP_AFTER = words(
	", ( [ { ; } => = . ?. ? : && || ?? + - * / % < <= >= == === != !== & | ^ ~ += -= *= /= %= &= |= ^= <<= >>= >>>= &&= ||= ??= **= ** << >> >>>",
);
const WRAP_BEFORE = words(
	") ] } . ?. , ; ? : => + - * / % < > <= >= == === != !== & | ^ && || ?? { in instanceof ** << >> >>>",
);
const HEADER_WORDS = words("if for while switch with await");
const KEEP_SEMICOLON_AFTER = words("else : =>");
const ASI_HAZARDS = words("( [ ` + - / ++ --");
const OPENING = new Map([
	["(", ")"],
	["[", "]"],
	["{", "}"],
]);
const CLOSING = new Set(OPENING.values());
const MAX_LINE = 2000;
const MAX_DEPTH = 200;
const ODD_BREAKS =
	/[\r\v\f\u0085\u2028\u2029\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
const UNSAFE_TEXT = /`|"""|'''|<<[-~]?\s*['"]?\w/;
const JSX_START = /<[A-Za-z][\w.-]*[\s>/]|<\/|\/>|<>/;
const BLOCK_SCALAR = /[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/;
const F_OPEN = /(?<![\p{L}\p{N}_])(?:[rR][fF]|[fF][rR]?)(["'])/gu;
const IDENTIFIER = /[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*/uy;
const NUMBER = /0[xXoObB]\w*|\d[\d_]*(?:\.(?!\.)[\d_]*)?(?:[eE][+-]?\d+)?\w*/y;
const STRING_PREFIX = /^[rbfuRBFU]{1,2}$/;
const STATEMENT_END = /^(?:[\p{L}\p{N}_$"'`]|\)|\]|\}|\+\+|--)/u;

interface Tokenized {
	tokens: string[];
	starts: number[];
}

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Whether a file may hold JSX text, where whitespace, commas and quotes are content. JSX
 * and TSX files always may; other JavaScript and TypeScript files may when the text shows
 * an element start, a closing tag, a self-closing slash or a fragment.
 */
export function jsxPossible(filename: string, text: string): boolean {
	const ext = extensionOf(filename);
	return JSX_ALWAYS.has(ext) || (JSX_POSSIBLE.has(ext) && JSX_START.test(text));
}

/**
 * Whether any line of a patch for a JS, TS, Python or Go file opens a single or double quote
 * it does not close (a trailing backslash continues the string), so the lines around it may
 * sit inside a multi-line string body. Comment-looking lines are ignored.
 */
export function opensUnclosedString(filename: string, patch: string): boolean {
	const ext = extensionOf(filename);
	if (!(JS_LIKE.has(ext) || PYTHON.has(ext) || ext === "go")) return false;
	for (const row of patch.split("\n")) {
		if (/^.\s*(?:\*|\/\*)/.test(row)) continue;
		let quote = "";
		for (let i = 1; i < row.length; i++) {
			const ch = row[i] as string;
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = "";
			} else if (ch === '"' || ch === "'") quote = ch;
			else if (PYTHON.has(ext) ? ch === "#" : row.startsWith("//", i)) break;
		}
		if (quote && !row.endsWith("\\")) return true;
	}
	return false;
}

/**
 * Whether a JS, TS or Go patch has a block comment that is closed without an opener, never
 * closed, or holds a changed line, so changed lines may be comment text. Conservative:
 * delimiters inside strings count too.
 */
export function unbalancedBlockComment(
	filename: string,
	patch: string,
): boolean {
	const ext = extensionOf(filename);
	if (!(JS_LIKE.has(ext) || ext === "go")) return false;
	let open = false;
	for (const row of patch.split("\n")) {
		if (open && /^[-+]/.test(row)) return true;
		for (const [mark] of row.matchAll(/\/\*|\*\//g)) {
			if (mark === "/*") open = true;
			else if (!open) return true;
			else open = false;
		}
	}
	return open;
}

function nestsFStringQuote(line: string): boolean {
	F_OPEN.lastIndex = 0;
	for (let m = F_OPEN.exec(line); m; m = F_OPEN.exec(line)) {
		let depth = 0;
		let i = m.index + m[0].length;
		for (; i < line.length && (line[i] !== m[1] || depth > 0); i++) {
			const c = line[i];
			if (c === "\\") i++;
			else if (c === "{") depth++;
			else if (c === "}" && depth > 0) depth--;
			else if (c === m[1]) return true;
		}
		F_OPEN.lastIndex = i;
	}
	return false;
}

/** Whether any line of a YAML patch, context included, ends in a block scalar header. */
export function hasBlockScalarHeader(filename: string, patch: string): boolean {
	return (
		LINE_MODE.has(extensionOf(filename)) &&
		patch.split("\n").some((row) => BLOCK_SCALAR.test(row.trimEnd()))
	);
}

function unreadable(line: string, ext: string): boolean {
	if (line.length > MAX_LINE) return true;
	const body = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (ODD_BREAKS.test(body)) return true;
	if (JS_LIKE.has(ext) && (body.includes("<!--") || body.includes("-->")))
		return true;
	if (PYTHON.has(ext)) return nestsFStringQuote(body);
	return false;
}

function stringEnd(line: string, start: number): number {
	const quote = line[start];
	let j = start + 1;
	while (j < line.length && line[j] !== quote) j += line[j] === "\\" ? 2 : 1;
	return j < line.length ? j + 1 : -1;
}

function isDivision(before: string[]): boolean {
	const last = before[before.length - 1];
	if (last === undefined) return false;
	if (last === "]" || /^\d/.test(last)) return true;
	return /^[\p{L}_$]/u.test(last) && !BEFORE_EXPRESSION.has(last);
}

function pick(re: RegExp, line: string, at: number): string | undefined {
	re.lastIndex = at;
	return re.exec(line)?.[0];
}

function scanLine(line: string, ext: string): string[] | null {
	const out: string[] = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i] as string;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (HASH_COMMENTS.has(ext) && ch === "#") return null;
		if (
			SLASH_COMMENTS.has(ext) &&
			(line.startsWith("//", i) || line.startsWith("/*", i))
		)
			return null;
		let quoteAt = ch === '"' || ch === "'" ? i : -1;
		let word: string | undefined;
		if (quoteAt < 0) {
			word = pick(IDENTIFIER, line, i);
			const after = i + (word?.length ?? 0);
			if (
				word &&
				PYTHON.has(ext) &&
				STRING_PREFIX.test(word) &&
				(line[after] === '"' || line[after] === "'")
			)
				quoteAt = after;
		}
		if (quoteAt >= 0) {
			const end = stringEnd(line, quoteAt);
			if (end < 0) return null;
			out.push(line.slice(i, end));
			i = end;
			continue;
		}
		if (word) {
			out.push(word);
			i += word.length;
			continue;
		}
		const num = pick(NUMBER, line, i);
		if (num) {
			out.push(num);
			i += num.length;
			continue;
		}
		const op =
			checkerOperatorsFor(ext).find((o) => line.startsWith(o, i)) ?? ch;
		if (JS_LIKE.has(ext) && op.startsWith("/") && !isDivision(out)) return null;
		out.push(op);
		i += op.length;
	}
	return out;
}

function endsStatement(token: string | undefined): boolean {
	return token !== undefined && token !== "\n" && STATEMENT_END.test(token);
}

function tokenizeLines(lines: string[], ext: string): Tokenized | null {
	const free = FREE.has(ext);
	const braceBlocks = BRACE_BLOCKS.has(ext);
	const tokens: string[] = [];
	const starts: number[] = [];
	const open: string[] = [];
	let depth = 0;
	const grouped = () =>
		braceBlocks ? open.length > 0 && open[open.length - 1] !== "{" : depth > 0;
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n] as string;
		if (UNSAFE_TEXT.test(line)) return null;
		const found = scanLine(line, ext);
		if (!found) return null;
		const first = found[0];
		const last = found[found.length - 1];
		if (first === undefined || last === undefined) continue;
		if (
			JS_LIKE.has(ext) &&
			ASI_HAZARDS.has(first) &&
			endsStatement(tokens[tokens.length - 1])
		)
			tokens.push("\n");
		const before = tokens[tokens.length - 1];
		if (
			free &&
			before !== undefined &&
			before !== "\n" &&
			(BREAKING_WORDS.has(before) ||
				!(WRAP_AFTER.has(before) || WRAP_BEFORE.has(first)))
		)
			tokens.push("\n");
		if (!free && !grouped()) starts.push(n);
		for (const t of found) {
			tokens.push(t);
			if (free) continue;
			if (braceBlocks) {
				if (OPENING.has(t)) open.push(t);
				else if (CLOSING.has(t)) open.pop();
			} else if (t === "(" || t === "[") depth++;
			else if (t === ")" || t === "]") depth--;
		}
		if (free ? BREAKING_WORDS.has(last) : !grouped()) tokens.push("\n");
	}
	if (tokens[tokens.length - 1] === "\n") tokens.pop();
	return { tokens, starts };
}

function balanced(tokens: string[]): boolean {
	const stack: string[] = [];
	for (const t of tokens) {
		const close = OPENING.get(t);
		if (close) {
			stack.push(close);
			if (stack.length > MAX_DEPTH) return false;
		} else if (CLOSING.has(t) && stack.pop() !== t) return false;
	}
	return stack.length === 0;
}

interface Shape {
	sibling: boolean[];
	parenOpen: number[];
}

function shapeOf(tokens: string[], ext: string): Shape {
	const sibling = tokens.map(() => false);
	const parenOpen = tokens.map(() => -1);
	const lambdas = PYTHON.has(ext);
	const groups = [{ seen: false, params: 0 }];
	const parens: number[] = [];
	tokens.forEach((t, k) => {
		const group = groups[groups.length - 1] as (typeof groups)[number];
		if (OPENING.has(t)) {
			groups.push({ seen: false, params: 0 });
			if (t === "(") parens.push(k);
		} else if (CLOSING.has(t)) {
			if (groups.length > 1) groups.pop();
			if (t === ")") parenOpen[k] = parens.pop() ?? -1;
		} else if (t === ",") {
			sibling[k] = group.seen;
			if (group.params === 0) group.seen = true;
		} else if (lambdas && t === "lambda") group.params++;
		else if (lambdas && t === ":" && group.params > 0) group.params--;
	});
	return { sibling, parenOpen };
}

function removableComma(
	tokens: string[],
	at: number,
	ext: string,
	shape: Shape,
): boolean {
	const next = tokens[at + 1];
	if (next === undefined || !CLOSING.has(next)) return false;
	if (JS_LIKE.has(ext)) {
		const prev = tokens[at - 1];
		return (
			prev !== undefined && prev !== "," && prev !== "\n" && !OPENING.has(prev)
		);
	}
	return shape.sibling[at] === true && SIBLING_COMMA.has(ext);
}

function keepsSemicolon(tokens: string[], at: number, shape: Shape): boolean {
	if (KEEP_SEMICOLON_AFTER.has(tokens[at - 1] ?? "")) return true;
	if (tokens[at - 1] !== ")") return false;
	const open = shape.parenOpen[at - 1] ?? -1;
	return open > 0 && HEADER_WORDS.has(tokens[open - 1] ?? "");
}

function swappable(token: string, ext: string): boolean {
	if (!QUOTE_SWAP.has(ext)) return false;
	if (token.length < 2 || !token.startsWith("'") || !token.endsWith("'"))
		return false;
	const body = token.slice(1, -1);
	if (/["'\\]|\$\{/.test(body)) return false;
	return !(PYTHON.has(ext) && /[{}]/.test(body));
}

function normalized(tokens: string[], ext: string): string[] {
	const shape = shapeOf(tokens, ext);
	const out: string[] = [];
	tokens.forEach((t, i) => {
		if (t === "," && removableComma(tokens, i, ext, shape)) return;
		if (
			t === ";" &&
			JS_LIKE.has(ext) &&
			tokens[i + 1] === "}" &&
			!keepsSemicolon(tokens, i, shape)
		)
			return;
		out.push(swappable(t, ext) ? `"${t.slice(1, -1)}"` : t);
	});
	return out;
}

function indentShape(
	lines: string[],
	starts: number[],
): { base: number; depths: number[] } | null {
	for (const line of lines) {
		if (line.trim() !== "" && !/^ *\S/.test(line)) return null;
	}
	const indents = starts.map((n) => (lines[n] as string).search(/\S/));
	const base = Math.min(...indents);
	return { base, depths: indents.map((d) => d - base) };
}

function lineModeTokens(lines: string[]): Tokenized | null {
	if (lines.some((l) => UNSAFE_TEXT.test(l) || BLOCK_SCALAR.test(l.trimEnd())))
		return null;
	const starts = lines.flatMap((l, n) => (l.trim() === "" ? [] : [n]));
	return { tokens: lines.map((l) => l.trim()), starts };
}

function trailingSpace(lines: string[], starts: number[]): string[] {
	return starts.map((n) => {
		const line = lines[n] as string;
		const body = line.endsWith("\r") ? line.slice(0, -1) : line;
		return String(body.length - body.trimEnd().length);
	});
}

function sameTokens(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Whether two blocks hold the same token stream once formatting-only differences are
 * removed, written independently of the matcher's tokenizer. Only `CHECKER_FAMILIES` are
 * accepted, and both files must share one. Comments, templates, triple-quoted strings,
 * heredocs, possible regex literals, odd terminators or spaces, nested f-strings, long
 * lines, JSX-capable files, YAML scalars, unbalanced or deep brackets and JS or TS line
 * breaks that are not obviously a wrap are differences. Indentation-sensitive files must
 * indent with spaces only and keep the same relative indentation; `reindent` is the shift
 * of the head block against the base block (0 elsewhere).
 */
export function tokenEquivalent(
	baseLines: string[],
	headLines: string[],
	baseFile: string,
	headFile: string,
): { equivalent: boolean; reindent?: number } {
	const no = { equivalent: false };
	const ext = extensionOf(baseFile);
	const headExt = extensionOf(headFile);
	const family = FAMILY_OF.get(ext);
	if (family === undefined || family !== FAMILY_OF.get(headExt)) return no;
	if (baseLines.some((l) => unreadable(l, ext))) return no;
	if (headLines.some((l) => unreadable(l, headExt))) return no;
	if (jsxPossible(baseFile, baseLines.join("\n"))) return no;
	if (jsxPossible(headFile, headLines.join("\n"))) return no;
	const lineMode = LINE_MODE.has(ext);
	const base = lineMode
		? lineModeTokens(baseLines)
		: tokenizeLines(baseLines, ext);
	const head = lineMode
		? lineModeTokens(headLines)
		: tokenizeLines(headLines, headExt);
	if (!base || !head) return no;
	if (!lineMode && !(balanced(base.tokens) && balanced(head.tokens))) return no;
	if (
		lineMode &&
		!sameTokens(
			trailingSpace(baseLines, base.starts),
			trailingSpace(headLines, head.starts),
		)
	)
		return no;
	const baseTokens = lineMode ? base.tokens : normalized(base.tokens, ext);
	const headTokens = lineMode ? head.tokens : normalized(head.tokens, headExt);
	if (baseTokens.length === 0 || !sameTokens(baseTokens, headTokens)) return no;
	if (!INDENTED.has(ext)) return { equivalent: true, reindent: 0 };
	const baseShape = indentShape(baseLines, base.starts);
	const headShape = indentShape(headLines, head.starts);
	if (!baseShape || !headShape) return no;
	if (!sameTokens(baseShape.depths.map(String), headShape.depths.map(String)))
		return no;
	return { equivalent: true, reindent: headShape.base - baseShape.base };
}
