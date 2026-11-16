import { isIndentSensitive, type PushFile } from "../moved-blocks.js";
import type { Divergence, Operation, Span } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const TRIPLE_QUOTE = /"""|'''/g;
const HEREDOC_OPEN = /<<[-~]?\s*['"]?(\w+)/;

interface Side {
	filename: string;
	lines: string[];
	positions: number[];
	inLiteral: boolean[];
}

interface Entry {
	text: string;
	inLiteral: boolean;
	indentSensitive: boolean;
}

interface ChangedLines {
	deleted: Map<number, string>;
	added: Map<number, string>;
}

function changedLines(patch: string | undefined): ChangedLines {
	const out: ChangedLines = { deleted: new Map(), added: new Map() };
	let oldLine = 0;
	let newLine = 0;
	for (const row of (patch ?? "").split("\n")) {
		const header = HUNK_HEADER.exec(row);
		if (header) {
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
		} else if (row.startsWith("-")) {
			out.deleted.set(oldLine++, row.slice(1));
		} else if (row.startsWith("+")) {
			out.added.set(newLine++, row.slice(1));
		} else if (row.startsWith(" ")) {
			oldLine++;
			newLine++;
		}
	}
	return out;
}

function readSide(spans: Span[], files: PushFile[]): Side[] | null {
	const sides: Side[] = [];
	for (const span of spans) {
		const file = files.find((f) => f.filename === span.filename);
		if (!file) return null;
		const changed = changedLines(file.patch);
		const source = span.side === "base" ? changed.deleted : changed.added;
		const side: Side = {
			filename: span.filename,
			lines: [],
			positions: [],
			inLiteral: [],
		};
		for (let n = span.startLine; n <= span.endLine; n++) {
			const text = source.get(n);
			if (text === undefined) return null;
			side.lines.push(text);
			side.positions.push(n);
		}
		side.inLiteral = insideLiteral(side.lines);
		sides.push(side);
	}
	return sides;
}

function count(line: string, pattern: RegExp): number {
	return (line.match(pattern) ?? []).length;
}

/**
 * Marks each line that opens, sits inside or closes a multi-line template literal,
 * triple-quoted string or heredoc. A span whose delimiters do not balance is all marked.
 */
function insideLiteral(lines: string[]): boolean[] {
	const marks: boolean[] = [];
	let template = false;
	let triple = false;
	let heredocEnd: string | null = null;
	for (const line of lines) {
		let marked = template || triple || heredocEnd !== null;
		if (heredocEnd !== null && line.trim() === heredocEnd) heredocEnd = null;
		else if (heredocEnd === null) {
			if (count(line, /(?<!\\)`/g) % 2 === 1) {
				template = !template;
				marked = true;
			}
			if (count(line, TRIPLE_QUOTE) % 2 === 1) {
				triple = !triple;
				marked = true;
			}
			const opener = HEREDOC_OPEN.exec(line);
			if (opener) {
				heredocEnd = opener[1] as string;
				marked = true;
			}
		}
		marks.push(marked);
	}
	if (template || triple || heredocEnd !== null) return lines.map(() => true);
	return marks;
}

function claimLine(
	span: Span | undefined,
	sides: Side[],
	spent: Set<string>,
): string | null | undefined {
	if (!span) return undefined;
	if (span.startLine !== span.endLine) return null;
	const side = sides.find((s) => s.filename === span.filename);
	const at = side?.positions.indexOf(span.startLine) ?? -1;
	if (!side || at < 0) return null;
	const key = `${span.filename}:${span.startLine}`;
	if (spent.has(key)) return null;
	spent.add(key);
	return side.lines[at];
}

function supports(
	divergence: Divergence,
	base: string | null | undefined,
	head: string | null | undefined,
): boolean {
	if (base === null || head === null) return false;
	if (divergence.kind === "changed")
		return base !== undefined && head !== undefined && base !== head;
	if (divergence.kind === "removed")
		return base !== undefined && head === undefined;
	return head !== undefined && base === undefined;
}

function unclaimed(sides: Side[], spent: Set<string>): Entry[] {
	return sides.flatMap((side) =>
		side.lines.flatMap((text, i) =>
			spent.has(`${side.filename}:${side.positions[i]}`)
				? []
				: [
						{
							text,
							inLiteral: side.inLiteral[i] as boolean,
							indentSensitive: isIndentSensitive(side.filename),
						},
					],
		),
	);
}

function interior(line: string): string {
	const text = line.trim();
	return /["'`/]/.test(text) ? text : text.replace(/\s+/g, " ");
}

function pairsUp(base: Entry, head: Entry): boolean {
	if (base.text === head.text) return true;
	const safe = (entry: Entry) => !entry.inLiteral && !entry.indentSensitive;
	return (
		safe(base) && safe(head) && interior(base.text) === interior(head.text)
	);
}

function accountedPositionally(base: Entry[], head: Entry[]): boolean {
	return (
		base.length === head.length &&
		base.every((entry, i) => pairsUp(entry, head[i] as Entry))
	);
}

/**
 * Checks a relocation claim against the patches without using the matcher's alignment.
 * Every line of both spans must be an identical raw pair, a pair that differs only in
 * whitespace outside any multi-line literal of a file without significant indentation,
 * or a divergence the operation lists; a listed divergence the lines do not bear out
 * also fails the claim.
 */
export function verifyRelocation(op: Operation, files: PushFile[]): boolean {
	const base = readSide(op.from, files);
	const head = readSide(op.to, files);
	if (!base || !head) return false;
	const baseSpent = new Set<string>();
	const headSpent = new Set<string>();
	for (const divergence of op.divergences) {
		const baseLine = claimLine(divergence.base, base, baseSpent);
		const headLine = claimLine(divergence.head, head, headSpent);
		if (!supports(divergence, baseLine, headLine)) return false;
		if (
			divergence.original !== undefined &&
			baseLine !== undefined &&
			baseLine?.trim() !== divergence.original
		)
			return false;
	}
	return accountedPositionally(
		unclaimed(base, baseSpent),
		unclaimed(head, headSpent),
	);
}
