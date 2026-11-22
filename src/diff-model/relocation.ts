import {
	type Candidate,
	collectRuns,
	type PushFile,
	type Run,
	selectMatches,
} from "../moved-blocks.js";
import { acceptSeed, MIN_COUNTED_LINES } from "./acceptance.js";
import { type Built, build, chainSeeds, span } from "./block-build.js";
import { type BudgetLimits, WorkBudget } from "./budget.js";
import { findCopies } from "./copies.js";
import { findDeclarationMoves } from "./declarations.js";
import { INDENT_COLLAPSIBLE_FILE, UNMATCHED_FILES } from "./file-kinds.js";
import { findReshapes } from "./reshape.js";
import { filesWithLiterals, findTokenOperations } from "./token-pass.js";
import type { Operation } from "./types.js";

function toOperation(from: Run, to: Run, built: Built): Operation {
	const weighed = built.divergences.filter(
		(d) => d.class === "code" || d.class === "signature",
	).length;
	const hasReceiver = built.divergences.some((d) => d.class === "receiver");
	return {
		id: "",
		type: "relocation",
		from: [
			span(
				from.filename,
				"base",
				from.startLine + built.fromStart,
				from.startLine + built.fromEnd - 1,
			),
		],
		to: [
			span(
				to.filename,
				"head",
				to.startLine + built.toStart,
				to.startLine + built.toEnd - 1,
			),
		],
		exact: built.divergences.length === 0,
		divergences: built.divergences,
		reviewWeight: weighed + built.renamed + (hasReceiver ? 1 : 0),
	};
}

function claim(from: Run, to: Run, built: Built): void {
	for (let i = built.fromStart; i < built.fromEnd; i++) from.used[i] = true;
	for (let j = built.toStart; j < built.toEnd; j++) to.used[j] = true;
}

function resolveChain(chain: Candidate[], budget: WorkBudget): Operation[] {
	const { from, to } = chain[0] as Candidate;
	const whole = build(chain, true, budget);
	if (whole.counted <= whole.limit) {
		claim(from, to, whole);
		return [toOperation(from, to, whole)];
	}
	if (chain.length > 1)
		return chain.flatMap((seed) => resolveChain([seed], budget));
	const plain = build(chain, false, budget, true);
	claim(from, to, plain);
	return [toOperation(from, to, plain)];
}

/**
 * Finds blocks that were deleted from one region and added to another, across files or
 * within one file, tolerating a few changed, inserted or removed lines inside the block. Exact runs
 * seed each block, accepted by `acceptSeed`; the block is then widened over the lines between
 * and next to the seeds, its two sides are aligned, and every line that does not align
 * becomes a divergence classed as comment-only, rename or code. A block that would need more
 * than 3 differing lines or 20 percent of its length is reported as its exact runs only.
 * Lines are compared raw wherever whitespace-insensitive comparison is not known to be safe.
 * One-line declarations are then paired by name. One `WorkBudget` covers the call, and when
 * its pools run dry the pass stops silently and returns what it found.
 */
export function findRelocations(
	files: PushFile[],
	limits: Partial<BudgetLimits> = {},
): Operation[] {
	const matched = files.filter((f) => !UNMATCHED_FILES.test(f.filename));
	const { deleted, added } = collectRuns(
		matched,
		(name) => !INDENT_COLLAPSIBLE_FILE.test(name),
	);
	const budget = new WorkBudget(limits);
	const ctx = { deleted, added, budget };
	const seeds = selectMatches(deleted, added, 1, (c) => acceptSeed(c, ctx), {
		allowSameFile: true,
		uniqueBelow: MIN_COUNTED_LINES,
		charge: () => budget.spendExtensions(1),
	});
	const groups = new Map<string, Candidate[]>();
	for (const seed of seeds) {
		const key = `${seed.from.index}|${seed.to.index}`;
		groups.set(key, [...(groups.get(key) ?? []), seed]);
	}
	const chains = [...groups.values()].flatMap(chainSeeds);
	chains.sort(
		(a, b) =>
			size(b) - size(a) ||
			(a[0] as Candidate).from.index - (b[0] as Candidate).from.index,
	);
	const operations: Operation[] = [];
	const seedsExhausted = budget.exhausted;
	for (const chain of chains) {
		if (!seedsExhausted && budget.exhausted) break;
		operations.push(...resolveChain(chain, budget));
	}
	const literalFiles = filesWithLiterals(files);
	if (!budget.exhausted)
		operations.push(...findReshapes(deleted, added, budget, literalFiles));
	if (!budget.exhausted)
		operations.push(...findDeclarationMoves(deleted, added, budget));
	if (!budget.exhausted)
		operations.push(
			...findTokenOperations(deleted, added, budget, literalFiles),
		);
	const copies = budget.exhausted
		? []
		: findCopies(matched, added, budget, operations);
	const numbered = (ops: Operation[], prefix: string) =>
		ops.sort(byPosition).map((op, k) => ({ ...op, id: `${prefix}-${k + 1}` }));
	return [...numbered(operations, "relocation"), ...numbered(copies, "copy")];
}

function byPosition(a: Operation, b: Operation): number {
	return (
		compareText(a.from[0]?.filename, b.from[0]?.filename) ||
		(a.from[0]?.startLine ?? 0) - (b.from[0]?.startLine ?? 0) ||
		compareText(a.to[0]?.filename, b.to[0]?.filename) ||
		(a.to[0]?.startLine ?? 0) - (b.to[0]?.startLine ?? 0)
	);
}

function size(chain: Candidate[]): number {
	return chain.reduce((sum, seed) => sum + seed.counted, 0);
}

function compareText(a: string | undefined, b: string | undefined): number {
	return (a ?? "").localeCompare(b ?? "");
}
