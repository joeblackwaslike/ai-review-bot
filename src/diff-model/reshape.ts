import type { Run } from "../moved-blocks.js";
import { acceptSeed } from "./acceptance.js";
import type { WorkBudget } from "./budget.js";
import { literalSafe } from "./lexical.js";
import {
	asCandidate,
	claimable,
	extension,
	findMatches,
	indentShift,
	type Lens,
	logicalFirstLines,
	type Match,
	type Segment,
	span,
} from "./token-pass.js";
import { normalizeTokens, tokenize } from "./tokens.js";
import type { Divergence, Operation } from "./types.js";

const MAX_SIGNATURE_LINES = 16;
const PYTHON = new Set(["py", "pyi"]);
const RECEIVERS: Record<string, Record<string, string>> = {
	py: { self: ".", cls: "." },
	pyi: { self: ".", cls: "." },
	rs: { self: ".", Self: "::" },
	...Object.fromEntries(
		"js jsx mjs cjs ts tsx java cs kt kts dart"
			.split(" ")
			.map((ext) => [ext, { this: "." }]),
	),
};
const PYTHON_OPENER = /^\s*(?:async\s+)?def\s+\w/;
const RUST_OPENER =
	/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*fn\s+\w/;
const CONTROL =
	/^\s*(?:if|else|for|while|switch|catch|try|do|return|throw|new|synchronized|using|lock|when|foreach|await|yield|case)\b/;
const FUNCTION_KEYWORD =
	/^\s*(?:(?:export|default|async|public|private|protected|static|pub)\s+)*(?:function|fun)\b/;
const METHOD =
	/^\s*(?:(?:public|private|protected|internal|static|async|override|abstract|final|virtual|sealed|readonly|get|set|open|suspend|inline|synchronized|native|unsafe|partial)\s+)*(?:[\w$.<>,?[\]]+\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>()]*>)?\(/;
const DECORATOR = /^\s*@[\w.$]+/;
const RUST_ATTRIBUTE = /^\s*#\[.*\]\s*$/;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

interface LineRange {
	start: number;
	end: number;
}

function isOpener(line: string, ext: string): boolean {
	if (PYTHON.has(ext)) return PYTHON_OPENER.test(line);
	if (ext === "rs") return RUST_OPENER.test(line);
	if (CONTROL.test(line)) return false;
	return FUNCTION_KEYWORD.test(line) || METHOD.test(line);
}

function isDecorator(line: string, ext: string): boolean {
	return (ext === "rs" ? RUST_ATTRIBUTE : DECORATOR).test(line);
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
 * decorators (`@name`) or Rust attributes (`#[...]`) directly above it. Indices are inclusive
 * into `lines`. Null when the last line does not end a definition's opening, for files
 * outside py pyi js jsx mjs cjs ts tsx java cs rs kt kts dart.
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
		while (start > 0 && isDecorator(lines[start - 1] as string, ext)) start--;
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
		if (inside && inside.start <= first) return inside;
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

function logicalSignatureLines(
	run: Run,
	sig: LineRange,
	before: number,
): string[] {
	const ext = extension(run.filename);
	const out: string[] = [];
	for (let i = sig.start; i <= sig.end && i < before; i++) {
		out.push(run.raw[i] as string);
		if (!isDecorator(run.raw[i] as string, ext)) break;
	}
	return out;
}

function opensBrace(run: Run, sig: LineRange): boolean {
	const { tokens } = tokenize([run.raw[sig.end] as string], run.filename);
	return tokens[tokens.length - 1] === "{";
}

function closesWithin(
	seg: Segment,
	pos: number,
	len: number,
	opens: boolean,
): boolean {
	const start = opens ? 1 : 0;
	let depth = start;
	for (let k = pos; k < pos + len; k++) {
		const t = seg.tokens[k] as string;
		if (OPENERS.has(t)) depth++;
		else if (CLOSERS.has(t)) {
			depth--;
			if (depth < 0 || (opens && depth === 0 && k < pos + len - 1))
				return false;
		}
	}
	return depth === start || depth === 0;
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

function signatureDivergences(
	m: Match,
	base: LineRange,
	head: LineRange,
): Divergence[] {
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

function receiverDivergences(m: Match): Divergence[] {
	const { d, a, di, ai, len } = m.range;
	const seen = new Set<string>();
	const out: Divergence[] = [];
	for (let k = 0; k < len; k++) {
		if (d.dropped[di + k] === a.dropped[ai + k]) continue;
		const b = d.start + (d.lineOf[di + k] as number);
		const h = a.start + (a.lineOf[ai + k] as number);
		if (seen.has(`${b}|${h}`)) continue;
		seen.add(`${b}|${h}`);
		out.push(lineDivergence("changed", "receiver", b, h, d.run, a.run));
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

interface Sides {
	base: LineRange;
	head: LineRange;
}

function reshape(m: Match): Operation | null {
	const { d, a, di, ai, len } = m.range;
	const base = findSignature(d.run.raw, m.dFirst, m.dLast, d.run.filename);
	const head = findSignature(a.run.raw, m.aFirst, m.aLast, a.run.filename);
	if (!base || !head) return null;
	const sides: Sides = { base, head };
	const fromStart = Math.min(base.start, m.dFirst);
	const toStart = Math.min(head.start, m.aFirst);
	for (let i = fromStart; i < m.dFirst; i++) if (d.run.used[i]) return null;
	for (let j = toStart; j < m.aFirst; j++) if (a.run.used[j]) return null;
	if (
		!literalSafe(d.run.raw.slice(fromStart, m.dFirst), d.run.filename) ||
		!literalSafe(a.run.raw.slice(toStart, m.aFirst), a.run.filename)
	)
		return null;
	const opensBase = base.end < m.dFirst && opensBrace(d.run, base);
	const opensHead = head.end < m.aFirst && opensBrace(a.run, head);
	if (
		!closesWithin(d, di, len, opensBase) ||
		!closesWithin(a, ai, len, opensHead)
	)
		return null;
	const receivers = receiverDivergences(m);
	const same =
		signatureTokens(d.run, sides.base) === signatureTokens(a.run, sides.head);
	if (same && receivers.length === 0) return null;
	const shift = indentShift(
		d.run.indentSensitive,
		d.run.raw.slice(fromStart, m.dLast + 1),
		a.run.raw.slice(toStart, m.aLast + 1),
		[
			...logicalSignatureLines(d.run, base, m.dFirst),
			...logicalFirstLines(d, di, len),
		],
		[
			...logicalSignatureLines(a.run, head, m.aFirst),
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

function weigh(op: Operation): Operation {
	const counted = op.divergences.filter(
		(x) => x.class === "signature" || x.class === "code",
	).length;
	const receivers = op.divergences.some((x) => x.class === "receiver");
	return { ...op, reviewWeight: Math.max(counted, receivers ? 1 : 0) };
}

/**
 * Finds function-to-method and method-to-function conversions between unclaimed lines.
 * Body tokens are compared with receiver prefixes (`self.`, `cls.`, `this.`, `Self::`) removed;
 * the signatures above the matched bodies are paired however different they are. Each
 * signature line and each body line whose receiver differs becomes a divergence of class
 * `signature` or `receiver`; the review weight counts signature divergences and is at least
 * 1 when any receiver differs. A match needs a signature on both sides and either a
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
	for (const m of findMatches(deleted, added, budget, skip, receiverLens)) {
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
