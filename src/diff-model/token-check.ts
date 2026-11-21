import { OPERATORS } from "./tokens.js";

const FAMILIES = [
	["js", "jsx", "mjs", "cjs"],
	["ts", "tsx"],
	["java"],
	["c", "h", "cpp", "hpp"],
	["cs"],
	["rs"],
	["py", "pyi"],
	["go"],
	["kt", "kts"],
	["dart"],
	["yml", "yaml"],
];
const FAMILY_OF = new Map(
	FAMILIES.flatMap((names, i) => names.map((n) => [n, i] as const)),
);
const words = (list: string) => new Set(list.split(" "));
const LINE_MODE = words("yml yaml");
const FREE = words("js jsx mjs cjs ts tsx java c h cpp hpp cs rs");
const JS_LIKE = words("js jsx mjs cjs ts tsx");
const SLASH_COMMENTS = words(
	"js jsx mjs cjs ts tsx java c h cpp hpp cs rs go kt kts dart",
);
const HASH_COMMENTS = words("py pyi");
const PREPROCESSOR = words("c h cpp hpp cs");
const PYTHON = words("py pyi");
const INDENTED = words("py pyi yml yaml");
const SIBLING_COMMA = words("py pyi go rs kt kts dart");
const QUOTE_SWAP = words("js jsx mjs cjs ts tsx py pyi");
const BREAKING_WORDS = words("return throw break continue yield");
const BEFORE_EXPRESSION = words(
	"return typeof case in of delete void throw yield await else do instanceof new",
);
const HEADER_WORDS = words("if for while switch");
const ASI_HAZARDS = words("( [ ` + - / ++ --");
const OPENING = new Map([
	["(", ")"],
	["[", "]"],
	["{", "}"],
]);
const CLOSING = new Set(OPENING.values());
const UNSAFE_TEXT = /`|"""|'''|<<[-~]?\s*['"]?\w/;
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const NUMBER = /\d(?:\w|\.(?=\d))*/y;
const STRING_PREFIX = /^[rbfuRBFU]{1,2}$/;
const STATEMENT_END = /^(?:[\p{L}\p{N}_$"'`]|\)|\]|\}|\+\+|--)/u;
const CONTROL_WORD = /\b(?:if|while|for|with)\b/;

interface Tokenized {
	tokens: string[];
	starts: number[];
}

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

function stringEnd(line: string, start: number): number {
	const quote = line[start];
	let j = start + 1;
	while (j < line.length && line[j] !== quote) j += line[j] === "\\" ? 2 : 1;
	return j < line.length ? j + 1 : -1;
}

function isDivision(line: string, at: number, before: string[]): boolean {
	const last = before[before.length - 1];
	if (last === undefined) return false;
	if (last === ")") return !CONTROL_WORD.test(line.slice(0, at));
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
			let end = stringEnd(line, quoteAt);
			if (end < 0) {
				if (ext !== "rs" || line[quoteAt] !== "'") return null;
				end = line.length;
			}
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
		const op = OPERATORS.find((o) => line.startsWith(o, i)) ?? ch;
		if (JS_LIKE.has(ext) && op.startsWith("/") && !isDivision(line, i, out))
			return null;
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
	const tokens: string[] = [];
	const starts: number[] = [];
	let depth = 0;
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n] as string;
		if (UNSAFE_TEXT.test(line)) return null;
		if (PREPROCESSOR.has(ext) && line.trimStart().startsWith("#")) return null;
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
		if (!free && depth === 0) starts.push(n);
		for (const t of found) {
			tokens.push(t);
			if (!free && (t === "(" || t === "[")) depth++;
			else if (!free && (t === ")" || t === "]")) depth--;
		}
		if (free ? BREAKING_WORDS.has(last) : depth === 0) tokens.push("\n");
	}
	if (tokens[tokens.length - 1] === "\n") tokens.pop();
	return { tokens, starts };
}

function balanced(tokens: string[]): boolean {
	const stack: string[] = [];
	for (const t of tokens) {
		const close = OPENING.get(t);
		if (close) stack.push(close);
		else if (CLOSING.has(t) && stack.pop() !== t) return false;
	}
	return stack.length === 0;
}

function hasSiblingComma(tokens: string[], at: number): boolean {
	let depth = 0;
	for (let k = at - 1; k >= 0; k--) {
		const t = tokens[k] as string;
		if (CLOSING.has(t)) depth++;
		else if (OPENING.has(t)) {
			if (depth === 0) return false;
			depth--;
		} else if (t === "," && depth === 0) return true;
	}
	return false;
}

function closesLoopHeader(tokens: string[], at: number): boolean {
	if (tokens[at - 1] !== ")") return false;
	let depth = 0;
	for (let k = at - 1; k >= 0; k--) {
		if (tokens[k] === ")") depth++;
		else if (tokens[k] === "(" && --depth === 0)
			return HEADER_WORDS.has(tokens[k - 1] ?? "");
	}
	return false;
}

function removableComma(tokens: string[], at: number, ext: string): boolean {
	const next = tokens[at + 1];
	if (next === undefined || !CLOSING.has(next)) return false;
	if (JS_LIKE.has(ext)) {
		const prev = tokens[at - 1];
		return (
			prev !== undefined && prev !== "," && prev !== "\n" && !OPENING.has(prev)
		);
	}
	return SIBLING_COMMA.has(ext) && hasSiblingComma(tokens, at);
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
	const out: string[] = [];
	tokens.forEach((t, i) => {
		if (t === "," && removableComma(tokens, i, ext)) return;
		if (
			t === ";" &&
			JS_LIKE.has(ext) &&
			tokens[i + 1] === "}" &&
			!closesLoopHeader(tokens, i)
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
	if (lines.some((l) => UNSAFE_TEXT.test(l))) return null;
	const starts = lines.flatMap((l, n) => (l.trim() === "" ? [] : [n]));
	return { tokens: starts.map((n) => (lines[n] as string).trim()), starts };
}

function sameTokens(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Whether two blocks hold the same token stream once formatting-only differences are
 * removed, written independently of the matcher's tokenizer. Both files must share a
 * language family from a fixed allowlist, no line may hold a comment, template literal,
 * triple-quoted string, heredoc, C preprocessor directive or possible regex literal,
 * and brackets must balance. Indentation-sensitive files must indent with spaces only
 * and keep the same relative indentation; `reindent` is the uniform shift of the head
 * block against the base block (0 elsewhere).
 */
export function tokenEquivalent(
	baseLines: string[],
	headLines: string[],
	baseFile: string,
	headFile: string,
): { equivalent: boolean; reindent?: number } {
	const no = { equivalent: false };
	const ext = extensionOf(baseFile);
	const family = FAMILY_OF.get(ext);
	if (family === undefined || family !== FAMILY_OF.get(extensionOf(headFile)))
		return no;
	const lineMode = LINE_MODE.has(ext);
	const base = lineMode
		? lineModeTokens(baseLines)
		: tokenizeLines(baseLines, ext);
	const head = lineMode
		? lineModeTokens(headLines)
		: tokenizeLines(headLines, extensionOf(headFile));
	if (!base || !head) return no;
	if (!lineMode && !(balanced(base.tokens) && balanced(head.tokens))) return no;
	const baseTokens = lineMode ? base.tokens : normalized(base.tokens, ext);
	const headTokens = lineMode
		? head.tokens
		: normalized(head.tokens, extensionOf(headFile));
	if (baseTokens.length === 0 || !sameTokens(baseTokens, headTokens)) return no;
	if (!INDENTED.has(ext)) return { equivalent: true, reindent: 0 };
	const baseShape = indentShape(baseLines, base.starts);
	const headShape = indentShape(headLines, head.starts);
	if (!baseShape || !headShape) return no;
	if (!sameTokens(baseShape.depths.map(String), headShape.depths.map(String)))
		return no;
	return { equivalent: true, reindent: headShape.base - baseShape.base };
}
