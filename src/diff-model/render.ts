import { fenceUntrusted } from "../prompt.js";
import type { FileKind } from "../push-shape.js";
import type { DiffModel, Divergence, Operation, Span } from "./types.js";

export interface RenderedDiffModel {
	summary: string;
	fileNotes: ReadonlyMap<string, string>;
}

const MAX_DETAILED_OPERATIONS = 12;
const MAX_VALUE_CHARS = 200;
const MAX_CLAIM_PHRASES = 3;

const HEADING =
	"Computed notes (not part of the diff; the diff wins if they disagree)";

const FIXED_PARAGRAPH =
	"These notes are computed from the diff. They are not part of it, and when they disagree with it the diff wins. " +
	"A move implies spending effort on what the move could break and is visible in this diff: import lines, mocks, test and config paths. " +
	"You cannot read other files in this version, so say what you could not check instead of guessing.";

const KIND_ORDER: FileKind[] = [
	"code",
	"test",
	"docs",
	"config",
	"infra",
	"shell",
	"binary",
	"generated",
	"lockfile",
];

const DIVERGENCE_LABEL: Record<Divergence["kind"], string> = {
	changed: "Changed",
	inserted: "Inserted",
	removed: "Removed",
};

const DIVERGENCE_CLASS: Record<Divergence["class"], string> = {
	code: "code",
	"comment-only": "comment only",
	rename: "identifier rename",
};

const TYPE_PLURAL: Record<Operation["type"], string> = {
	relocation: "relocation",
	rename: "rename",
	mechanical: "mechanical",
};

function untrusted(value: string): string {
	const clipped =
		value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value;
	return fenceUntrusted(clipped);
}

function lineRange(start: number, end: number): string {
	return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function spanRange(span: Span): string {
	const prefix = span.side === "base" ? "base " : "";
	return `${prefix}${lineRange(span.startLine, span.endLine)}`;
}

function shownWording(span: Span): string {
	const verb = span.side === "base" ? "deleted" : "added";
	if (span.shown === "full") return verb;
	return span.shown === "none"
		? `${verb} lines not shown`
		: `${verb}, partly shown`;
}

function spanText(span: Span): string {
	const shown = shownWording(span);
	return `${untrusted(span.filename)} ${spanRange(span)} (${shown})`;
}

function spansText(spans: Span[]): string {
	return spans.map(spanText).join(", ");
}

function divergenceSpan(d: Divergence): Span | undefined {
	return d.head ?? d.base;
}

function divergenceText(d: Divergence): string {
	const at = divergenceSpan(d);
	const where = at ? `: ${spanText(at)}` : "";
	const original =
		d.original === undefined
			? ""
			: `, the original was ${untrusted(d.original)}`;
	return `${DIVERGENCE_LABEL[d.kind]} (${DIVERGENCE_CLASS[d.class]})${where}${original}.`;
}

function hasCodeDivergence(op: Operation): boolean {
	return op.divergences.some((d) => d.class === "code");
}

function rank(op: Operation): number {
	if (op.type === "relocation") return hasCodeDivergence(op) ? 0 : 1;
	return op.type === "rename" ? 2 : 3;
}

function rankOperations(operations: Operation[]): Operation[] {
	return operations
		.map((op, index) => ({ op, index }))
		.sort((a, b) => rank(a.op) - rank(b.op) || a.index - b.index)
		.map(({ op }) => op);
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function headline(op: Operation): string {
	if (op.type === "relocation") {
		const n = op.divergences.length;
		const lead =
			n > 0
				? `Relocation with ${plural(n, "difference")} from the original`
				: "Relocation";
		return `${lead}: ${spansText(op.from)} match ${spansText(op.to)}.`;
	}
	if (op.type === "rename") {
		const from = op.from[0]?.filename ?? "";
		const to = op.to[0]?.filename ?? "";
		const content = op.exact
			? "the compared content is identical"
			: "the content also changed, see its diff";
		return `Rename: ${untrusted(from)} to ${untrusted(to)}, ${content}.`;
	}
	const spans = op.to.length > 0 ? op.to : op.from;
	return `Mechanical: the lines shown differ only in whitespace, or the lines shown are import lines only (${spansText(spans)}).`;
}

function detailBlock(op: Operation, number: number): string {
	const lines = [`${number}. ${headline(op)}`];
	for (const d of op.divergences) lines.push(`   ${divergenceText(d)}`);
	return lines.join("\n");
}

function addNote(notes: Map<string, string[]>, filename: string, text: string) {
	const list = notes.get(filename) ?? [];
	list.push(text);
	notes.set(filename, list);
}

function addFileNotes(
	notes: Map<string, string[]>,
	op: Operation,
	number: number,
): void {
	const see = `see operation ${number}`;
	if (op.type === "relocation") {
		for (const s of op.from) {
			addNote(
				notes,
				s.filename,
				`Relocated out, ${spanRange(s)}${s.shown === "full" ? "" : ` (${shownWording(s)})`}, ${see}`,
			);
		}
		for (const s of op.to) {
			const own = op.divergences.filter(
				(d) => divergenceSpan(d)?.filename === s.filename,
			);
			const lines = own.map((d) => {
				const at = divergenceSpan(d);
				return at
					? `${spanRange(at)} differs from the original`
					: "differs from the original";
			});
			const tail = lines.length > 0 ? `, ${lines.join(", ")}` : "";
			addNote(
				notes,
				s.filename,
				`Relocated in, ${lineRange(s.startLine, s.endLine)}, ${see}${tail}`,
			);
		}
		return;
	}
	if (op.type === "rename") {
		for (const s of op.from) addNote(notes, s.filename, `Renamed away, ${see}`);
		for (const s of op.to) addNote(notes, s.filename, `Renamed here, ${see}`);
		return;
	}
	for (const s of op.to.length > 0 ? op.to : op.from) {
		addNote(
			notes,
			s.filename,
			`Mechanical, ${spanRange(s)}: the lines shown differ only in whitespace, or the lines shown are import lines only, ${see}`,
		);
	}
}

function fileMix(model: DiffModel): string | null {
	if (model.files.length === 0) return null;
	const counts = new Map<FileKind, number>();
	for (const f of model.files)
		counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
	const parts = KIND_ORDER.filter((k) => counts.has(k)).map(
		(k) => `${counts.get(k)} ${k}`,
	);
	return `${plural(model.files.length, "file")}: ${parts.join(", ")}.`;
}

function testsLine(testsChanged: boolean | "unknown"): string {
	if (testsChanged === "unknown") return "Tests: unknown, not established.";
	return testsChanged
		? "Tests: test files changed in this PR."
		: "Tests: no test files changed.";
}

function countsLine(omitted: Operation[]): string | null {
	if (omitted.length === 0) return null;
	const byType = new Map<Operation["type"], number>();
	for (const op of omitted) byType.set(op.type, (byType.get(op.type) ?? 0) + 1);
	const parts = [...byType].map(([t, n]) => `${n} ${TYPE_PLURAL[t]}`);
	return `Not detailed: ${parts.join(", ")}.`;
}

function intentLine(
	model: DiffModel,
	ranked: Operation[],
	detailCount: number,
): string | null {
	const phrases = model.facts.intentClaims
		.slice(0, MAX_CLAIM_PHRASES)
		.map((c) => untrusted(c.phrase));
	if (phrases.length === 0) return null;
	const says = `The description says ${phrases.join(" and ")}.`;
	const codeIndex = ranked.findIndex(hasCodeDivergence);
	if (codeIndex >= 0) {
		const d = ranked[codeIndex]?.divergences.find((x) => x.class === "code");
		const at = d ? divergenceSpan(d) : undefined;
		const where = at ? ` at ${untrusted(at.filename)} ${spanRange(at)}` : "";
		const subject =
			codeIndex < detailCount
				? `Operation ${codeIndex + 1}`
				: "An operation not detailed here";
		return `${says} ${subject} has a code difference from the original${where}.`;
	}
	const nonMechanical = ranked.filter((op) => op.type !== "mechanical");
	if (nonMechanical.length > 0) {
		return `${says} This scope contains ${plural(nonMechanical.length, "relocation or rename operation")}.`;
	}
	if (ranked.length === 0)
		return `${says} No operations were detected in this scope.`;
	return says;
}

function nothingToSay(model: DiffModel): boolean {
	const kinds = new Set(model.files.map((f) => f.kind));
	return (
		model.operations.length === 0 &&
		model.facts.intentClaims.length === 0 &&
		model.droppedClaims === 0 &&
		kinds.size < 2
	);
}

interface Layout {
	summary: string;
	notes: Map<string, string>;
	size: number;
}

function layout(
	model: DiffModel,
	ranked: Operation[],
	detailCount: number,
	scopeLabel: string,
): Layout {
	const detailed = ranked.slice(0, detailCount);
	const noteLists = new Map<string, string[]>();
	for (const [i, op] of detailed.entries()) addFileNotes(noteLists, op, i + 1);
	const notes = new Map(
		[...noteLists].map(([file, list]) => [file, list.join("\n")]),
	);

	const sections: (string | null)[] = [
		HEADING,
		FIXED_PARAGRAPH,
		`Scope: ${scopeLabel}.`,
		fileMix(model),
		ranked.length > 0 ? "Operations in this scope, most relevant first:" : null,
		...detailed.map((op, i) => detailBlock(op, i + 1)),
		countsLine(ranked.slice(detailCount)),
		model.droppedClaims > 0
			? `${plural(model.droppedClaims, "relocation claim")} ${model.droppedClaims === 1 ? "was" : "were"} not confirmed by an independent check and is not listed.`
			: null,
		testsLine(model.facts.testsChanged),
		intentLine(model, ranked, detailCount),
	];
	const summary = sections.filter((s): s is string => s !== null).join("\n");
	const size =
		summary.length + [...notes.values()].reduce((n, t) => n + t.length, 0);
	return { summary, notes, size };
}

/**
 * Renders the model as computed notes for the reviewer prompt: a summary for the top of
 * the section and per-file notes to place before each file's diff text. It reports facts
 * and never judges whether a change is functional. Author-derived values are clipped and
 * fenced as untrusted. The total length stays within `maxChars` by dropping the
 * lowest-ranked operation detail first, keeping the per-type counts.
 */
export function renderDiffModel(
	model: DiffModel,
	opts: { maxChars: number; scopeLabel: string },
): RenderedDiffModel {
	if (nothingToSay(model)) return { summary: "", fileNotes: new Map() };
	const ranked = rankOperations(model.operations);
	let count = Math.min(ranked.length, MAX_DETAILED_OPERATIONS);
	let result = layout(model, ranked, count, opts.scopeLabel);
	while (result.size > opts.maxChars && count > 0) {
		count -= 1;
		result = layout(model, ranked, count, opts.scopeLabel);
	}
	return { summary: result.summary, fileNotes: result.notes };
}
