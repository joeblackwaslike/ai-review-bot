import type { Run } from "../moved-blocks.js";
import { acceptSeed, MIN_COUNTED_LINES } from "./acceptance.js";
import type { WorkBudget } from "./budget.js";
import { literalSafe, MAX_ANALYZED_LINE } from "./lexical.js";
import {
	asCandidate,
	balanced,
	claimable,
	extension,
	findMatches,
	indentShift,
	type Lens,
	logicalFirstLines,
	type Match,
	span,
} from "./token-pass.js";
import { CLOSERS, normalizeTokens, OPENERS, tokenize } from "./tokens.js";
import type { Divergence, Operation } from "./types.js";

const MAX_SIGNATURE_LINES = 16;
const MIN_COUNTED_LENGTH = 3;
const PYTHON = new Set(["py", "pyi"]);
/**
 * Receiver prefixes per extension. token-check.ts keeps its own copy (RESHAPE_RECEIVERS)
 * so the checker stays independent of the matcher; reshape.test.ts pins the two together.
 */
const RECEIVERS: Record<string, Record<string, string>> = {
	py: { self: ".", cls: "." },
	pyi: { self: ".", cls: "." },
	...Object.fromEntries(
		"js jsx mjs cjs ts tsx".split(" ").map((ext) => [ext, { this: "." }]),
	),
};
const PYTHON_OPENER = /^\s*(?:async\s+)?def\s+\w/;
const CONTROL =
	/^\s*(?:if|else|for|while|switch|catch|try|do|return|throw|new|with|using|await|yield|case)\b/;
const FUNCTION_KEYWORD =
	/^\s*(?:(?:export|default|async|public|private|protected|static)\s+)*function\b/;
const METHOD = /^\s*(?:[\w$.<>,?[\]]+\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>()]*>)?\(/;
const ASSIGNMENT = new Set(
	"= += -= *= /= %= **= //= &= |= ^= <<= >>= >>>= &&= ||= ??= :=".split(" "),
);
const DECORATOR = /^\s*@[\w.$]+/;

interface LineRange {
	start: number;
	end: number;
}

function isOpener(line: string, ext: string): boolean {
	if (line.length > MAX_ANALYZED_LINE) return false;
	if (PYTHON.has(ext)) return PYTHON_OPENER.test(line);
	if (CONTROL.test(line)) return false;
	return FUNCTION_KEYWORD.test(line) || METHOD.test(line);
}

function isDecorator(line: string): boolean {
	return DECORATOR.test(line);
}

function closesCleanly(lines: readonly string[], filename: string): boolean {
	const terminator = PYTHON.has(extension(filename)) ? ":" : "{";
	const { tokens, lineOf } = tokenize(lines, filename);
	const last = tokens.length - 1;
	let end = last;
	while (end >= 0 && tokens[end] === "\n") end--;
	if (end < 0 || tokens[end] !== terminator) return false;
	let depth = 0;
	const endDepth: number[] = [];
	for (let k = 0; k < end; k++) {
		const t = tokens[k] as string;
		if (OPENERS.has(t)) depth++;
		else if (CLOSERS.has(t) && --depth < 0) return false;
		endDepth[lineOf[k] as number] = depth;
	}
	if (depth !== 0) return false;
	for (let l = 0; l < lines.length - 1; l++)
		if ((endDepth[l] ?? 0) <= 0) return false;
	return true;
}

/**
 * Finds the signature that ends on the last of `lines`: the opening logical line of a
 * definition, whose parameter list may span several lines (bracket depth decides), plus the
 * decorators (`@name`) directly above it. Indices are inclusive into `lines`. Returns null
 * for files outside py pyi js jsx mjs cjs ts tsx, for an empty `lines`, when a blank line
 * appears among the last 16 lines before an opening is found, and when no definition
 * opening within those 16 lines closes cleanly on the last line.
 */
export function signatureRange(
	lines: readonly string[],
	filename: string,
): LineRange | null {
	const ext = extension(filename);
	if (!RECEIVERS[ext]) return null;
	const end = lines.length - 1;
	if (end < 0) return null;
	for (let s = end; s >= Math.max(0, end - MAX_SIGNATURE_LINES + 1); s--) {
		if ((lines[s] as string).trim() === "") return null;
		if (!isOpener(lines[s] as string, ext)) continue;
		if (!closesCleanly(lines.slice(s, end + 1), filename)) continue;
		let start = s;
		while (start > 0 && isDecorator(lines[start - 1] as string)) start--;
		return { start, end };
	}
	return null;
}

function signatureEndingAt(
	raw: readonly string[],
	end: number,
	filename: string,
): LineRange | null {
	const lo = Math.max(0, end + 1 - 2 * MAX_SIGNATURE_LINES);
	const found = signatureRange(raw.slice(lo, end + 1), filename);
	return found && { start: found.start + lo, end: found.end + lo };
}

function findSignature(
	raw: readonly string[],
	first: number,
	last: number,
	filename: string,
): LineRange | null {
	const above = first > 0 ? signatureEndingAt(raw, first - 1, filename) : null;
	if (above) return above;
	for (let e = first; e <= Math.min(last, first + MAX_SIGNATURE_LINES); e++) {
		if ((raw[e] as string).trim() === "") return null;
		const inside = signatureEndingAt(raw, e, filename);
		if (inside && inside.start <= first)
			return { start: Math.max(inside.start, first), end: inside.end };
	}
	return null;
}

function signatureTokens(run: Run, sig: LineRange): string {
	const { tokens } = tokenize(
		run.raw.slice(sig.start, sig.end + 1),
		run.filename,
	);
	return normalizeTokens(tokens, run.filename).join("\u0001");
}

function openerLineAbove(run: Run, sig: LineRange, before: number): string[] {
	let i = sig.start;
	while (i < sig.end && isDecorator(run.raw[i] as string)) i++;
	return i < before ? [run.raw[i] as string] : [];
}

function decoratorCount(run: Run, sig: LineRange): number {
	let n = 0;
	while (
		sig.start + n < sig.end &&
		isDecorator(run.raw[sig.start + n] as string)
	)
		n++;
	return n;
}

function opensBrace(run: Run, sig: LineRange): boolean {
	const { tokens } = tokenize([run.raw[sig.end] as string], run.filename);
	return tokens[tokens.length - 1] === "{";
}

function lineDivergence(
	kind: Divergence["kind"],
	cls: Divergence["class"],
	baseIndex: number | undefined,
	headIndex: number | undefined,
	baseSpanRun: Run,
	headSpanRun: Run,
): Divergence {
	const out: Divergence = { kind, class: cls };
	if (baseIndex !== undefined) {
		out.base = span(baseSpanRun, "base", baseIndex, baseIndex);
		out.original = (baseSpanRun.raw[baseIndex] as string).trim();
	}
	if (headIndex !== undefined)
		out.head = span(headSpanRun, "head", headIndex, headIndex);
	return out;
}

function pairLines(m: Match, base: LineRange, head: LineRange): Divergence[] {
	const { d, a } = m.range;
	const baseLines = base.end - base.start + 1;
	const headLines = head.end - head.start + 1;
	const out: Divergence[] = [];
	for (let i = 0; i < Math.max(baseLines, headLines); i++) {
		const b = i < baseLines ? base.start + i : undefined;
		const h = i < headLines ? head.start + i : undefined;
		const kind =
			b === undefined ? "inserted" : h === undefined ? "removed" : "changed";
		out.push(lineDivergence(kind, "signature", b, h, d.run, a.run));
	}
	return out;
}

function signatureDivergences(
	m: Match,
	base: LineRange,
	head: LineRange,
): Divergence[] {
	const { d, a } = m.range;
	const baseDecorators = decoratorCount(d.run, base);
	const headDecorators = decoratorCount(a.run, head);
	return [
		...pairLines(
			m,
			{ start: base.start, end: base.start + baseDecorators - 1 },
			{ start: head.start, end: head.start + headDecorators - 1 },
		),
		...pairLines(
			m,
			{ start: base.start + baseDecorators, end: base.end },
			{ start: head.start + headDecorators, end: head.end },
		),
	];
}

/**
 * Classifies a line that differs from its counterpart only by receiver prefixes. `dropped`
 * lists, per token, the receiver stripped just before it on each side. The change is `code`
 * when a receiver was added, removed or changed on an assignment target (a differing token
 * before the first assignment operator of the line), or when one receiver was dropped and
 * another added on the same line, because both alter which state the line reads or writes.
 */
function receiverClass(
	tokens: readonly string[],
	baseDropped: readonly string[],
	headDropped: readonly string[],
): "receiver" | "code" {
	const assignAt = tokens.findIndex((t) => ASSIGNMENT.has(t));
	let lost = false;
	let gained = false;
	for (let k = 0; k < tokens.length; k++) {
		if (baseDropped[k] === headDropped[k]) continue;
		if (assignAt >= 0 && k < assignAt) return "code";
		if (baseDropped[k] && !headDropped[k]) lost = true;
		if (!baseDropped[k] && headDropped[k]) gained = true;
	}
	return lost && gained ? "code" : "receiver";
}

function receiverDivergences(m: Match): Divergence[] {
	const { d, a, di, ai, len } = m.range;
	const lines = new Map<string, number[]>();
	for (let k = 0; k < len; k++) {
		const key = `${d.lineOf[di + k]}|${a.lineOf[ai + k]}`;
		lines.set(key, [...(lines.get(key) ?? []), k]);
	}
	const out: Divergence[] = [];
	for (const [key, ks] of lines) {
		if (ks.every((k) => d.dropped[di + k] === a.dropped[ai + k])) continue;
		const [bl, hl] = key.split("|").map(Number) as [number, number];
		const cls = receiverClass(
			ks.map((k) => d.tokens[di + k] as string),
			ks.map((k) => d.dropped[di + k] as string),
			ks.map((k) => a.dropped[ai + k] as string),
		);
		out.push(
			lineDivergence("changed", cls, d.start + bl, a.start + hl, d.run, a.run),
		);
	}
	return out;
}

const receiverLens: Lens = {
	accepts: (filename) => RECEIVERS[extension(filename)] !== undefined,
	strip(tokens, lineOf, filename) {
		const rules = RECEIVERS[extension(filename)] ?? {};
		const out: string[] = [];
		const outLine: number[] = [];
		const dropped: string[] = [];
		let pending = "";
		for (let k = 0; k < tokens.length; k++) {
			const t = tokens[k] as string;
			const sep = rules[t];
			const before = tokens[k - 1];
			const after = tokens[k + 2];
			if (
				sep !== undefined &&
				tokens[k + 1] === sep &&
				after !== undefined &&
				after !== "\n" &&
				before !== "." &&
				before !== "::"
			) {
				pending = t + sep;
				k++;
				continue;
			}
			out.push(t);
			outLine.push(lineOf[k] as number);
			dropped.push(pending);
			pending = "";
		}
		return { tokens: out, lineOf: outLine, dropped };
	},
};

function reshape(m: Match): Operation | null {
	const { d, a, di, ai, len } = m.range;
	const base = findSignature(d.run.raw, m.dFirst, m.dLast, d.run.filename);
	const head = findSignature(a.run.raw, m.aFirst, m.aLast, a.run.filename);
	if (!base || !head) return null;
	const fromStart = Math.min(base.start, m.dFirst);
	const toStart = Math.min(head.start, m.aFirst);
	const counted = d.run.raw
		.slice(fromStart, m.dLast + 1)
		.filter((l) => l.trim().length >= MIN_COUNTED_LENGTH).length;
	if (counted < MIN_COUNTED_LINES) return null;
	for (let i = fromStart; i < m.dFirst; i++) if (d.run.used[i]) return null;
	for (let j = toStart; j < m.aFirst; j++) if (a.run.used[j]) return null;
	if (
		!literalSafe(d.run.raw.slice(fromStart, m.dFirst), d.run.filename) ||
		!literalSafe(a.run.raw.slice(toStart, m.aFirst), a.run.filename)
	)
		return null;
	const opensBase = base.end < m.dFirst && opensBrace(d.run, base);
	const opensHead = head.end < m.aFirst && opensBrace(a.run, head);
	if (!balanced(d, di, len, opensBase) || !balanced(a, ai, len, opensHead))
		return null;
	const receivers = receiverDivergences(m);
	const same = signatureTokens(d.run, base) === signatureTokens(a.run, head);
	if (same && receivers.length === 0) return null;
	const shift = indentShift(
		d.run.indentSensitive,
		d.run.raw.slice(fromStart, m.dLast + 1),
		a.run.raw.slice(toStart, m.aLast + 1),
		[
			...openerLineAbove(d.run, base, m.dFirst),
			...logicalFirstLines(d, di, len),
		],
		[
			...openerLineAbove(a.run, head, m.aFirst),
			...logicalFirstLines(a, ai, len),
		],
	);
	if (shift === null) return null;
	return {
		id: "",
		type: "relocation",
		from: [span(d.run, "base", fromStart, m.dLast)],
		to: [span(a.run, "head", toStart, m.aLast)],
		exact: false,
		divergences: [
			...(same ? [] : signatureDivergences(m, base, head)),
			...receivers,
		],
		reviewWeight: 0,
		...(shift !== 0 ? { shape: { reindent: shift } } : {}),
	};
}

/**
 * Classifies one changed physical line pair that differs only by receiver prefixes:
 * `receiver` for a plain change, `code` when the change touches an assignment target or
 * swaps one receiver for another, and null when the lines differ by anything else or are
 * outside the reshape languages. The comparison is per physical line, so a statement split
 * over several lines is judged one line at a time. The checker's `receiverOnlyLine` is
 * stricter and also refuses lines with comments or unreadable text.
 */
export function receiverChangeClass(
	base: string,
	head: string,
	baseFilename: string,
	headFilename: string,
): "receiver" | "code" | null {
	if (
		!receiverLens.accepts(baseFilename) ||
		!receiverLens.accepts(headFilename)
	)
		return null;
	const side = (line: string, filename: string) => {
		const tokens = normalizeTokens(tokenize([line], filename).tokens, filename);
		return receiverLens.strip(
			tokens,
			tokens.map(() => 0),
			filename,
		);
	};
	const b = side(base, baseFilename);
	const h = side(head, headFilename);
	const key = (xs: string[]) => xs.join("\u0001");
	if (key(b.tokens) !== key(h.tokens) || key(b.dropped) === key(h.dropped))
		return null;
	return receiverClass(b.tokens, b.dropped, h.dropped);
}

function reshapeWeight(divergences: Divergence[]): number {
	const counted = divergences.filter(
		(x) => x.class === "signature" || x.class === "code",
	).length;
	return counted + (divergences.some((x) => x.class === "receiver") ? 1 : 0);
}

function weigh(op: Operation): Operation {
	return { ...op, reviewWeight: reshapeWeight(op.divergences) };
}

/**
 * Finds function-to-method and method-to-function conversions between unclaimed lines.
 * Body tokens are compared with receiver prefixes (`self.`, `cls.`, `this.`) removed;
 * the signatures above the matched bodies are paired however different they are. Each
 * signature line becomes a `signature` divergence. Each body line whose receiver differs
 * becomes a `receiver` divergence, or a `code` one when the change touches an assignment
 * target or swaps one receiver for another. The review weight counts signature and code
 * divergences and adds 1 when any receiver divergence is present; `toOperation` in
 * relocation.ts is the canonical formula. A match needs a signature on both sides and either a
 * different signature or a receiver difference, otherwise the plain token pass takes it.
 * Uses the token pass guards: file allowlist, literal safety, balanced brackets, relative
 * indentation in Python, comment cuts, seed acceptance and the work budget.
 */
export function findReshapes(
	deleted: Run[],
	added: Run[],
	budget: WorkBudget,
	skip: ReadonlySet<string>,
): Operation[] {
	const ctx = { deleted, added, budget };
	const out: Operation[] = [];
	const defines = (run: Run) =>
		RECEIVERS[extension(run.filename)] !== undefined &&
		run.raw.some((line) => isOpener(line, extension(run.filename)));
	const from = deleted.filter(defines);
	const to = added.filter(defines);
	if (from.length === 0 || to.length === 0) return out;
	for (const m of findMatches(from, to, budget, skip, receiverLens)) {
		if (budget.exhausted) break;
		if (!claimable(m)) continue;
		const op = reshape(m);
		if (!op) continue;
		if (!acceptSeed(asCandidate(m), ctx)) continue;
		const { d, a } = m.range;
		const from = op.from[0];
		const to = op.to[0];
		if (!from || !to) continue;
		for (let i = from.startLine - d.run.startLine; i <= m.dLast; i++)
			d.run.used[i] = true;
		for (let j = to.startLine - a.run.startLine; j <= m.aLast; j++)
			a.run.used[j] = true;
		out.push(weigh(op));
	}
	return out;
}
