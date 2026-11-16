import type {
	DiffModel,
	Divergence,
	Operation,
	Span,
} from "../../diff-model/types.js";
import type { SeedOperation, SeedSpan } from "./schema.js";

export interface DetectionScore {
	matched: number;
	missing: SeedOperation[];
	unexpected: Operation[];
	divergenceMisses: number;
}

const overlaps = (truth: SeedSpan, found: Span): boolean =>
	truth.filename === found.filename &&
	truth.side === found.side &&
	truth.startLine <= found.endLine &&
	found.startLine <= truth.endLine;

function spansMatch(truth: SeedSpan[], found: Span[]): boolean {
	return (
		truth.length === found.length &&
		truth.every((t) => found.some((f) => overlaps(t, f)))
	);
}

function sideMatches(truth: SeedSpan | undefined, found: Span | undefined) {
	return truth === undefined || found === undefined
		? truth === found
		: overlaps(truth, found);
}

function divergenceMatches(
	truth: SeedOperation["divergences"][number],
	found: Divergence,
): boolean {
	return (
		truth.kind === found.kind &&
		sideMatches(truth.base, found.base) &&
		sideMatches(truth.head, found.head)
	);
}

function divergenceMisses(
	truth: SeedOperation["divergences"],
	found: Divergence[],
): number {
	const unclaimed = [...found];
	let misses = 0;
	for (const t of truth) {
		const at = unclaimed.findIndex((f) => divergenceMatches(t, f));
		if (at === -1) misses++;
		else unclaimed.splice(at, 1);
	}
	return misses + unclaimed.length;
}

/**
 * Scores a model's operations against a seed's expected ones. An operation matches by type
 * and by spans that overlap the expected spans in the same file and side. Divergences are
 * scored on matched operations: one the truth lists and the model lacks, or one the model
 * reports and the truth does not list, each counts as a miss. An operation the truth does
 * not list is `unexpected`.
 */
export function scoreDetection(
	truthOps: SeedOperation[],
	model: DiffModel,
): DetectionScore {
	const unclaimed = [...model.operations];
	const missing: SeedOperation[] = [];
	let matched = 0;
	let misses = 0;
	for (const expected of truthOps) {
		const at = unclaimed.findIndex(
			(op) =>
				op.type === expected.type &&
				spansMatch(expected.from, op.from) &&
				spansMatch(expected.to, op.to),
		);
		if (at === -1) {
			missing.push(expected);
			continue;
		}
		const [found] = unclaimed.splice(at, 1);
		matched++;
		misses += divergenceMisses(expected.divergences, found.divergences);
	}
	return {
		matched,
		missing,
		unexpected: unclaimed,
		divergenceMisses: misses,
	};
}
