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
	divergencesMissed: number;
	divergencesExtra: number;
}

const EDGE_TOLERANCE_LINES = 1;

const covers = (truth: SeedSpan, found: Span): boolean =>
	truth.filename === found.filename &&
	truth.side === found.side &&
	found.startLine <= truth.startLine &&
	found.endLine >= truth.endLine &&
	truth.startLine - found.startLine <= EDGE_TOLERANCE_LINES &&
	found.endLine - truth.endLine <= EDGE_TOLERANCE_LINES;

function spansMatch(truth: SeedSpan[], found: Span[]): boolean {
	if (truth.length !== found.length) return false;
	const unclaimed = [...found];
	for (const t of truth) {
		const at = unclaimed.findIndex((f) => covers(t, f));
		if (at === -1) return false;
		unclaimed.splice(at, 1);
	}
	return true;
}

function sideMatches(truth: SeedSpan | undefined, found: Span | undefined) {
	return truth === undefined || found === undefined
		? truth === found
		: covers(truth, found);
}

function divergenceMatches(
	truth: SeedOperation["divergences"][number],
	found: Divergence,
): boolean {
	return (
		truth.kind === found.kind &&
		truth.class === found.class &&
		sideMatches(truth.base, found.base) &&
		sideMatches(truth.head, found.head)
	);
}

function divergenceCounts(
	truth: SeedOperation["divergences"],
	found: Divergence[],
): { missed: number; extra: number } {
	const unclaimed = [...found];
	let missed = 0;
	for (const t of truth) {
		const at = unclaimed.findIndex((f) => divergenceMatches(t, f));
		if (at === -1) missed++;
		else unclaimed.splice(at, 1);
	}
	return { missed, extra: unclaimed.length };
}

function operationMatches(expected: SeedOperation, op: Operation): boolean {
	return (
		op.type === expected.type &&
		(expected.exact === undefined || expected.exact === op.exact) &&
		(expected.reason === undefined || expected.reason === op.reason) &&
		spansMatch(expected.from, op.from) &&
		spansMatch(expected.to, op.to)
	);
}

/**
 * Scores a model's operations against a seed's expected ones. An operation matches by type
 * and by spans that each contain one expected span in the same file and side, extending past it by at most `EDGE_TOLERANCE_LINES` on each side. Each found span satisfies one expected span. Divergences are
 * scored on matched operations: one the truth lists and the model lacks counts as missed,
 * and one the model reports and the truth does not list counts as extra. A divergence
 * matches by kind, class and spans. When the truth states `exact` or `reason`, the model's
 * operation must agree to match. An operation the truth does not list is `unexpected`.
 */
export function scoreDetection(
	truthOps: SeedOperation[],
	model: DiffModel,
): DetectionScore {
	const unclaimed = [...model.operations];
	const missing: SeedOperation[] = [];
	let matched = 0;
	let divergencesMissed = 0;
	let divergencesExtra = 0;
	for (const expected of truthOps) {
		const at = unclaimed.findIndex((op) => operationMatches(expected, op));
		if (at === -1) {
			missing.push(expected);
			continue;
		}
		const [found] = unclaimed.splice(at, 1);
		matched++;
		const counts = divergenceCounts(expected.divergences, found.divergences);
		divergencesMissed += counts.missed;
		divergencesExtra += counts.extra;
	}
	return {
		matched,
		missing,
		unexpected: unclaimed,
		divergencesMissed,
		divergencesExtra,
	};
}
