import { isIndentSensitive, type PushFile } from "../moved-blocks.js";
import { DATA_FILE, PROSE_FILE, UNMATCHED_FILES } from "./file-kinds.js";
import {
	type ChangeIndex,
	claimedDivergences,
	classesHold,
	IMPORT_LINE,
	indexOf,
	isDefinition,
	type Side,
	SMALL_CLAIM_LINES,
	SMALL_DEFINITION_CHARS,
} from "./relocation-check.js";
import type { Operation, Span } from "./types.js";

const PROPERTY_LINE =
	/^(?:\.\.\.\S.*|["']?[\w$-]+["']?\??:(?:\s.*)?|[\w$]+|[{[(]+|[}\])]+[,;)]*)$/;
const IMPORT_CLOSER = /^[})\]]\s*from\b/;
const BARE_NAME = /^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?,?$/;
const NAME = /[A-Za-z_$][\w$]*/g;
const MIN_LINE_CHARS = 3;
const MAX_FLOOR_LINE = 500;
const WHOLE_COMMENT_LINE = /^(?:\/\/|\/\*|\*\/|\*(?:\s|$))/;
const HASH_COMMENT_LINE = /^#(?![![])/;
const HASH_FILES = /\.(?:py|pyi|sh|bash|zsh|rb|ya?ml|toml|mk)$/i;
const WHITESPACE_FREE_FILES =
	/\.(?:[cm]?[jt]sx?|java|go|rs|c|h|cc|cpp|cxx|hpp|cs|kt|kts|swift|php|scala|dart|css|scss|less)$/i;
const IDLE_WORDS = new Set(
	`if else for while do return break continue switch case default try catch finally
	throw new function class def fn func end let const var in of async await yield
	import export from as true false null undefined this self super static public
	private protected void and or not is then pub mut type interface enum extends
	implements with lambda pass assert defer match`.split(/\s+/),
);
const REGION_TOKENS =
	/\/\*|\*\/|`|"""|'''|<<[-~]?(["']?)([A-Za-z_]\w*)\1|\\[\s\S]|"|'|\/\/|#/g;

interface HeadRead {
	side: Side;
	segment: number;
}

interface FileRegions {
	unsafe: Set<number>;
	risky: boolean;
}

const coverages = new WeakMap<
	readonly Operation[],
	{ targets: Map<string, Set<number>>; reviewed: Map<string, Set<number>> }
>();
const regionCaches = new WeakMap<object, FileRegions>();

function eligible(filename: string): boolean {
	return (
		!DATA_FILE.test(filename) &&
		!PROSE_FILE.test(filename) &&
		!UNMATCHED_FILES.test(filename)
	);
}

function closer(text: string, from: number, close: string): number {
	for (let i = from; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text.startsWith(close, i)) return i;
	}
	return -1;
}

/** Unsafe lines and risk for one file, scanned from its head rows, as the matcher does. */
export function regionsOfRows(
	filename: string,
	rows: [number, string][],
): FileRegions {
	const hash = HASH_FILES.test(filename);
	const unsafe = new Set<number>();
	let open: { close: string; at: number; word?: string } | null = null;
	for (const [n, text] of rows) {
		if (open?.word !== undefined) {
			if (text.trim() === open.word) {
				for (let k = open.at; k <= n; k++) unsafe.add(k);
				open = null;
			}
			continue;
		}
		let skip = 0;
		let quote = "";
		for (const m of text.matchAll(REGION_TOKENS)) {
			const at = m.index as number;
			const token = m[0];
			if (at < skip) continue;
			if (open) {
				if (token !== open.close) continue;
				for (let k = open.at; k <= n; k++) unsafe.add(k);
				open = null;
				quote = "";
				continue;
			}
			if (quote) {
				if (token === quote) quote = "";
				continue;
			}
			const spaced = at === 0 || /\s/.test(text[at - 1] as string);
			if (token === "//") {
				if (spaced && !hash) break;
			} else if (token === "#") {
				if (spaced && hash) break;
			} else if (token === '"' || token === "'") {
				quote = token;
			} else if (m[2] !== undefined) {
				open = { close: "", at: n, word: m[2] };
				break;
			} else if (token !== "*/" && !token.startsWith("\\")) {
				const end = token === "/*" ? "*/" : token;
				const found = closer(text, at + token.length, end);
				if (found >= 0) skip = found + end.length;
				else {
					open = { close: end, at: n };
					break;
				}
			}
		}
	}
	return { unsafe, risky: open !== null };
}

function regionsOf(filename: string, index: ChangeIndex): FileRegions {
	const file = index.byName.get(filename);
	if (!file) return { unsafe: new Set(), risky: false };
	const cached = regionCaches.get(file);
	if (cached) return cached;
	const rows: [number, string][] = [
		...file.changed.added,
		...file.changed.context,
	].sort((a, b) => a[0] - b[0]);
	const built = regionsOfRows(filename, rows);
	regionCaches.set(file, built);
	return built;
}

function readHead(
	span: Span,
	index: ChangeIndex,
	allowContext: boolean,
): HeadRead | null {
	if (span.side !== "head" || span.endLine < span.startLine) return null;
	const file = index.byName.get(span.filename);
	if (!file) return null;
	const regions = regionsOf(span.filename, index);
	if (regions.risky) return null;
	const { added, context, segments } = file.changed;
	const lines: string[] = [];
	const positions: number[] = [];
	let segment: number | undefined;
	for (let n = span.startLine; n <= span.endLine; n++) {
		const text = added.get(n) ?? (allowContext ? context.get(n) : undefined);
		const seen = segments.get(n);
		if (text === undefined || seen === undefined) return null;
		if (regions.unsafe.has(n)) return null;
		if (segment !== undefined && seen !== segment) return null;
		segment = seen;
		lines.push(text);
		positions.push(n);
	}
	return {
		segment: segment as number,
		side: {
			filename: span.filename,
			lines,
			positions,
			inLiteral: lines.map(() => false),
			hunks: new Set(),
			groups: new Set(),
			following: undefined,
		},
	};
}

function coverageOf(verified: readonly Operation[]) {
	const cached = coverages.get(verified);
	if (cached) return cached;
	const targets = new Map<string, Set<number>>();
	const reviewed = new Map<string, Set<number>>();
	const into = (map: Map<string, Set<number>>, name: string) => {
		let lines = map.get(name);
		if (!lines) {
			lines = new Set();
			map.set(name, lines);
		}
		return lines;
	};
	for (const op of verified) {
		if (op.type === "copy") continue;
		for (const span of op.to) {
			if (span.side !== "head") continue;
			const own = new Set<number>();
			for (let n = span.startLine; n <= span.endLine; n++) own.add(n);
			for (const n of own) into(targets, span.filename).add(n);
			for (const d of op.divergences)
				if (d.head?.filename === span.filename)
					for (let n = d.head.startLine; n <= d.head.endLine; n++)
						own.delete(n);
			for (const n of own) into(reviewed, span.filename).add(n);
		}
	}
	const built = { targets, reviewed };
	coverages.set(verified, built);
	return built;
}

function withoutLiterals(line: string): { rest: string; had: boolean } {
	const dead = new Set<string>();
	const pieces: string[] = [];
	let had = false;
	let i = 0;
	while (i < line.length) {
		const ch = line[i] as string;
		if ("\"'`".includes(ch) && !dead.has(ch)) {
			let j = i + 1;
			while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
			if (j < line.length) {
				pieces.push(" ");
				had = true;
				i = j + 1;
				continue;
			}
			dead.add(ch);
		}
		const before = i > 0 ? (line[i - 1] as string) : "";
		if (ch >= "0" && ch <= "9" && !/\w/.test(before)) {
			let j = i + 1;
			while (j < line.length && /[\w.]/.test(line[j] as string)) j++;
			pieces.push(" ");
			had = true;
			i = j;
			continue;
		}
		pieces.push(ch);
		i++;
	}
	return { rest: pieces.join(""), had };
}

function bracketBalance(text: string): number {
	let balance = 0;
	for (const ch of text) {
		if (ch === "(" || ch === "[" || ch === "{") balance++;
		else if (ch === ")" || ch === "]" || ch === "}") balance--;
	}
	return balance;
}

function bracketsClose(lines: string[]): boolean {
	let depth = 0;
	for (const line of lines) {
		depth += bracketBalance(withoutLiterals(line).rest);
		if (depth < 0) return false;
	}
	return depth === 0;
}

function onlyProperties(lines: string[]): boolean {
	return lines.every((line) => {
		const text = line.trim().replace(/,$/, "");
		return text === "" || PROPERTY_LINE.test(text);
	});
}

function lineWeight(line: string): number {
	const text = line.trim();
	if (text === "" || IMPORT_LINE.test(text)) return 0;
	const { rest, had } = withoutLiterals(text);
	const named = (rest.match(NAME) ?? []).some((w) => !IDLE_WORDS.has(w));
	const literalOnly = had && /[^\s,;:()[\]{}]/.test(rest);
	return named || literalOnly ? text.replace(/\s/g, "").length : 0;
}

function hasSubstance(lines: string[]): boolean {
	let depth = 0;
	return lines.some((line) => {
		const text = line.trim();
		if (depth > 0) {
			depth += bracketBalance(text);
			return false;
		}
		if (IMPORT_LINE.test(text)) {
			depth = Math.max(0, bracketBalance(text));
			return false;
		}
		if (IMPORT_CLOSER.test(text) || BARE_NAME.test(text)) return false;
		return lineWeight(text) > 0;
	});
}

/** The copy floor, reimplemented here on purpose. A test pins it equal to the matcher's. */
export function floorHolds(
	lines: string[],
	indentSensitive: boolean,
	hash = false,
): boolean {
	if (lines.some((l) => l.length > MAX_FLOOR_LINE)) return false;
	const present = lines.map((l) => l.trim()).filter((l) => l !== "");
	if (
		present.every(
			(l) => WHOLE_COMMENT_LINE.test(l) || (hash && HASH_COMMENT_LINE.test(l)),
		)
	)
		return false;
	const counted = lines.filter((l) => l.trim().length >= MIN_LINE_CHARS).length;
	const chars = present.join("").replace(/\s/g, "").length;
	const definition =
		present.length >= 3 &&
		!(present[0] as string).startsWith("const ") &&
		isDefinition(lines, indentSensitive) &&
		chars >= SMALL_DEFINITION_CHARS;
	if (counted < SMALL_CLAIM_LINES && !definition) return false;
	return hasSubstance(lines) && bracketsClose(lines) && !onlyProperties(lines);
}

function rangesOverlap(a: Side, b: Side): boolean {
	return (
		a.filename === b.filename &&
		(a.positions[0] as number) <= (b.positions.at(-1) as number) &&
		(b.positions[0] as number) <= (a.positions.at(-1) as number)
	);
}

function interior(line: string): string {
	const text = line.trim();
	return /["'`/]/.test(text) ? text : text.replace(/\s+/g, " ");
}

function leftover(side: Side, spent: Set<string>): string[] {
	return side.lines.filter(
		(_, i) => !spent.has(`${side.filename}:${side.positions[i]}`),
	);
}

function sameText(
	from: Side,
	to: Side,
	spent: { base: Set<string>; head: Set<string> },
	tolerant: boolean,
): boolean {
	const left = leftover(from, spent.base);
	const right = leftover(to, spent.head);
	if (left.length !== right.length) return false;
	return left.every((line, i) => {
		const other = right[i] as string;
		if (line === other) return true;
		if (!tolerant || /\\\s*$/.test(line) || /\\\s*$/.test(other)) return false;
		return interior(line) === interior(other);
	});
}

/**
 * Checks a copy claim against the patches without using the matcher. Both spans are head-side
 * ranges inside one run each: the target added lines, the source added or context lines of a
 * different run, with no overlap. Prose, JSON and lockfiles are out. No span may begin inside
 * or touch a multi-line comment, template literal, triple-quoted string or heredoc, and a file
 * whose patch leaves one open has no copy. The block must clear the copy floor, which is
 * reimplemented here on purpose so the checker shares no code with the matcher: five counted
 * lines or a whole definition, no block of whole comment lines, no line over 500 characters,
 * brackets that close, and more than object properties. Divergences are checked as for
 * relocations, and a signature divergence is never valid. Lines outside them pair by raw text,
 * or ignoring whitespace only in brace languages whose patch has no literal opener.
 * `sourceNew` is recomputed: true when a source line is added and is neither a verified
 * non-copy target line nor one of that operation's own divergence lines. A target line of a
 * verified non-copy operation is never a copy. Claimed `sourceNew`, `reviewWeight` and `exact`
 * must match.
 */
export function verifyCopy(
	op: Operation,
	files: PushFile[],
	verified: readonly Operation[],
): boolean {
	const [fromSpan] = op.from;
	const [toSpan] = op.to;
	if (op.type !== "copy" || !fromSpan || !toSpan) return false;
	if (op.from.length !== 1 || op.to.length !== 1) return false;
	if (!eligible(fromSpan.filename) || !eligible(toSpan.filename)) return false;
	if (op.divergences.length > 0 && op.exact) return false;
	if (op.divergences.some((d) => d.class === "signature")) return false;
	if ((op.shape?.reindent ?? 0) !== 0) return false;
	const index = indexOf(files);
	const from = readHead(fromSpan, index, true);
	const to = readHead(toSpan, index, false);
	if (!from || !to) return false;
	if (rangesOverlap(from.side, to.side)) return false;
	if (from.side.filename === to.side.filename && from.segment === to.segment)
		return false;
	const hash = HASH_FILES.test(from.side.filename);
	if (!floorHolds(from.side.lines, isIndentSensitive(from.side.filename), hash))
		return false;
	const { targets, reviewed } = coverageOf(verified);
	const taken = targets.get(to.side.filename);
	if (to.side.positions.some((n) => taken?.has(n) === true)) return false;
	const known = reviewed.get(from.side.filename);
	const added = index.byName.get(from.side.filename)?.changed.added;
	const sourceNew = from.side.positions.some(
		(n) => added?.has(n) === true && known?.has(n) !== true,
	);
	if ((op.shape?.sourceNew === true) !== sourceNew) return false;
	const spent = claimedDivergences(op, [from.side], [to.side]);
	if (!spent) return false;
	const weight = classesHold(op, [from.side], [to.side]);
	if (weight === null) return false;
	if (op.reviewWeight !== (sourceNew ? Math.max(1, weight) : weight))
		return false;
	const tolerant = [from.side.filename, to.side.filename].every(
		(name) =>
			WHITESPACE_FREE_FILES.test(name) &&
			index.byName.get(name)?.risky === false,
	);
	return sameText(from.side, to.side, spent, tolerant);
}
