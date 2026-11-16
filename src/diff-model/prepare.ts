import { type PackedDiff, type PackedFile, packDiff } from "../diff-pack.js";
import type { PushFile } from "../moved-blocks.js";
import { buildDiffModel } from "./index.js";
import { type RenderedDiffModel, renderDiffModel } from "./render.js";
import type { DiffModel, Shown, Span } from "./types.js";

interface ShownRanges {
	base: Array<[number, number]>;
	head: Array<[number, number]>;
}

function shownRanges(patch: string | undefined): ShownRanges {
	const ranges: ShownRanges = { base: [], head: [] };
	if (!patch) return ranges;
	let old = 0;
	let now = 0;
	let open: { base: number; head: number } | null = null;
	const close = () => {
		if (!open) return;
		if (old > open.base) ranges.base.push([open.base, old - 1]);
		if (now > open.head) ranges.head.push([open.head, now - 1]);
		open = null;
	};
	for (const line of patch.split("\n")) {
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (header) {
			close();
			old = Number(header[1]);
			now = Number(header[2]);
			open = { base: old, head: now };
		} else if (!open) continue;
		else if (line.startsWith("+")) now++;
		else if (line.startsWith("-")) old++;
		else if (line.startsWith(" ")) {
			old++;
			now++;
		}
	}
	close();
	return ranges;
}

function coverage(span: Span, ranges: Array<[number, number]>): Shown {
	const total = span.endLine - span.startLine + 1;
	let covered = 0;
	for (let n = span.startLine; n <= span.endLine; n++)
		if (ranges.some(([a, b]) => n >= a && n <= b)) covered++;
	if (covered === 0) return "none";
	return covered === total ? "full" : "partial";
}

function fileShown(packed: PackedFile | undefined, omitted: boolean): Shown {
	if (omitted || packed?.deletionsOnly) return "none";
	if (packed && (packed.truncated || packed.droppedDeletionHunks > 0))
		return "partial";
	return "full";
}

function applyVisibility(
	model: DiffModel,
	scopeFiles: readonly PushFile[],
	packed: PackedDiff,
): void {
	const omitted = new Set(packed.omitted);
	const byName = new Map(packed.files.map((f) => [f.filename, f]));
	const alias = new Map<string, string>();
	for (const f of scopeFiles) {
		alias.set(f.filename, f.filename);
		if (f.previous_filename) alias.set(f.previous_filename, f.filename);
	}
	for (const node of model.files)
		node.shown = fileShown(
			byName.get(node.filename),
			omitted.has(node.filename),
		);
	const ranges = new Map(
		packed.files.map((f) => [f.filename, shownRanges(f.patch)]),
	);
	const mark = (span: Span) => {
		const name = alias.get(span.filename) ?? span.filename;
		if (omitted.has(name)) {
			span.shown = "none";
			return;
		}
		const r = ranges.get(name);
		span.shown = r ? coverage(span, r[span.side]) : "full";
	};
	for (const op of model.operations) {
		op.from.forEach(mark);
		op.to.forEach(mark);
		for (const d of op.divergences) {
			if (d.base) mark(d.base);
			if (d.head) mark(d.head);
		}
	}
}

/**
 * Builds the model from the full patches, packs the same files exactly as the prompt does,
 * then records what the reviewer will actually see on each file and span before rendering
 * the notes. The packed text does not depend on the model.
 */
export function prepareDiffInput(input: {
	scopeFiles: PushFile[];
	prFiles: PushFile[];
	prFilesComplete: boolean;
	title: string;
	body: string | null;
	budgetChars: number;
	sectionBudgetChars: number;
	scopeLabel: string;
}): { packed: PackedDiff; model: DiffModel; rendered: RenderedDiffModel } {
	const model = buildDiffModel(input);
	const packed = packDiff(input.scopeFiles, { budgetChars: input.budgetChars });
	applyVisibility(model, input.scopeFiles, packed);
	const rendered = renderDiffModel(model, {
		maxChars: input.sectionBudgetChars,
		scopeLabel: input.scopeLabel,
	});
	return { packed, model, rendered };
}

/**
 * The computed notes for an audit, which has whole-file content and no patches: file kinds
 * and the author's stated intent. Returns the summary text, empty when there is nothing to say.
 */
export function prepareContentInput(input: {
	filenames: string[];
	title: string;
	body: string | null;
}): string {
	const files: PushFile[] = input.filenames.map((filename) => ({
		filename,
		status: "modified",
		additions: 0,
		deletions: 0,
	}));
	const model = buildDiffModel({
		scopeFiles: files,
		prFiles: files,
		prFilesComplete: true,
		title: input.title,
		body: input.body,
	});
	return renderDiffModel(model, {
		maxChars: Number.POSITIVE_INFINITY,
		scopeLabel: "the audited files",
	}).summary;
}
