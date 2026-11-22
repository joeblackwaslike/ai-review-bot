import { isIndentSensitive, type PushFile } from "../moved-blocks.js";
import { PROSE_FILE } from "./declarations.js";
import { UNMATCHED_FILES } from "./relocation.js";
import {
	accountedPositionally,
	type ChangeIndex,
	claimedDivergences,
	IMPORT_LINE,
	indexOf,
	information,
	insideLiteral,
	isDefinition,
	LITERALS,
	MIN_LINE_CHARS,
	type Side,
	SMALL_CLAIM_LINES,
	SMALL_DEFINITION_CHARS,
	unclaimed,
} from "./relocation-check.js";
import type { Operation, Span } from "./types.js";

const DATA_FILE = /\.jsonl?$/i;
const PROPERTY_LINE =
	/^(?:\.\.\.\S.*|["']?[\w$-]+["']?\??:(?:\s.*)?|[\w$]+|[{[(]+|[}\])]+[,;)]*)$/;
const IMPORT_CLOSER = /^[})\]]\s*from\b/;
const BARE_NAME = /^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?,?$/;

interface HeadRead {
	side: Side;
	segment: number;
}

const coverages = new WeakMap<readonly Operation[], Map<string, Set<number>>>();

function eligible(filename: string): boolean {
	return (
		!DATA_FILE.test(filename) &&
		!PROSE_FILE.test(filename) &&
		!UNMATCHED_FILES.test(filename)
	);
}

function readHead(
	span: Span,
	index: ChangeIndex,
	allowContext: boolean,
): HeadRead | null {
	if (span.side !== "head" || span.endLine < span.startLine) return null;
	const file = index.byName.get(span.filename);
	if (!file) return null;
	const { added, context, segments } = file.changed;
	const lines: string[] = [];
	const positions: number[] = [];
	let segment: number | undefined;
	for (let n = span.startLine; n <= span.endLine; n++) {
		const text = added.get(n) ?? (allowContext ? context.get(n) : undefined);
		const seen = segments.get(n);
		if (text === undefined || seen === undefined) return null;
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
			inLiteral: insideLiteral(lines),
			hunks: new Set(),
			groups: new Set(),
			following: undefined,
		},
	};
}

function coverageOf(verified: readonly Operation[]): Map<string, Set<number>> {
	const cached = coverages.get(verified);
	if (cached) return cached;
	const covered = new Map<string, Set<number>>();
	for (const op of verified) {
		if (op.type === "copy") continue;
		for (const span of op.to) {
			if (span.side !== "head") continue;
			let lines = covered.get(span.filename);
			if (!lines) {
				lines = new Set();
				covered.set(span.filename, lines);
			}
			for (let n = span.startLine; n <= span.endLine; n++) lines.add(n);
		}
	}
	coverages.set(verified, covered);
	return covered;
}

function bracketBalance(text: string): number {
	return (
		(text.match(/[({[]/g) ?? []).length - (text.match(/[)}\]]/g) ?? []).length
	);
}

function bracketsClose(lines: string[]): boolean {
	let depth = 0;
	for (const line of lines) {
		depth += bracketBalance(line.replace(LITERALS, " "));
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
		return information(text) > 0;
	});
}

function floorHolds(lines: string[], indentSensitive: boolean): boolean {
	const counted = lines.filter((l) => l.trim().length >= MIN_LINE_CHARS).length;
	const present = lines.map((l) => l.trim()).filter((l) => l !== "");
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

function expectedWeight(op: Operation, sourceNew: boolean): number {
	const weighed = op.divergences.filter((d) => d.class === "code").length;
	const receivers = op.divergences.some((d) => d.class === "receiver");
	const count = Math.max(weighed, receivers ? 1 : 0);
	return sourceNew ? Math.max(1, count) : count;
}

/**
 * Checks a copy claim against the patches without using the matcher. Both spans are head-side
 * ranges inside one run of the patch each: the target is added lines, the source added or
 * visible context lines of a different run, and the two do not overlap. Neither file may be prose,
 * JSON or a lockfile. The block must clear the copy floor (five counted lines, or a whole
 * definition of three lines and 40 characters), carry information, close its brackets and be
 * more than object properties. Divergences are checked as for relocations; a signature
 * divergence is never valid on a copy. `sourceNew` is recomputed: true when any source line
 * is an added line that no operation in `verified` (the already-verified non-copy
 * operations of the same model) has as its target. The claimed `sourceNew` and `reviewWeight` must
 * match, and `exact` cannot be true with divergences.
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
	if (!floorHolds(from.side.lines, isIndentSensitive(from.side.filename)))
		return false;
	const covered = coverageOf(verified).get(from.side.filename);
	const added = index.byName.get(from.side.filename)?.changed.added;
	const sourceNew = from.side.positions.some(
		(n) => added?.has(n) === true && covered?.has(n) !== true,
	);
	if ((op.shape?.sourceNew === true) !== sourceNew) return false;
	if (op.reviewWeight !== expectedWeight(op, sourceNew)) return false;
	const spent = claimedDivergences(op, [from.side], [to.side]);
	if (!spent) return false;
	return accountedPositionally(
		unclaimed([from.side], spent.base),
		unclaimed([to.side], spent.head),
	);
}
