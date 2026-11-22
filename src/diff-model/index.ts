import type { PushFile } from "../moved-blocks.js";
import { verifyCopy } from "./copy-check.js";
import { buildPrFacts } from "./facts.js";
import { buildFileNodes } from "./files.js";
import { findMechanical, findRenames } from "./operations.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation } from "./relocation-check.js";
import type { DiffModel, Operation, Span } from "./types.js";

/**
 * Builds the model of a push. Relocations are verified first, then copies against the verified relocations. Operations come from `scopeFiles`, facts from `prFiles`.
 * A relocation or copy the independent checker rejects is dropped and counted in `droppedClaims`.
 */
export function buildDiffModel(input: {
	scopeFiles: PushFile[];
	prFiles: PushFile[];
	prFilesComplete: boolean;
	title: string;
	body: string | null;
}): DiffModel {
	const { scopeFiles } = input;
	const claims = findRelocations(scopeFiles);
	const relocations = claims.filter((op) => op.type !== "copy");
	const copies = claims.filter((op) => op.type === "copy");
	const verifiedRelocations = relocations.filter((op) =>
		verifyRelocation(op, scopeFiles),
	);
	const verified = [
		...verifiedRelocations,
		...keepDistinctCopies(copies, scopeFiles, verifiedRelocations),
	];
	return {
		files: buildFileNodes(scopeFiles),
		operations: [
			...verified,
			...findRenames(scopeFiles),
			...findMechanical(scopeFiles),
		],
		facts: buildPrFacts(input),
		droppedClaims: claims.length - verified.length,
	};
}

function keepDistinctCopies(
	copies: Operation[],
	files: PushFile[],
	verifiedRelocations: Operation[],
): Operation[] {
	const taken = new Map<string, Set<number>>();
	const kept: Operation[] = [];
	for (const op of [...copies].sort(byTarget)) {
		if (!verifyCopy(op, files, verifiedRelocations)) continue;
		const span = op.to[0] as Span;
		const lines = taken.get(span.filename) ?? new Set<number>();
		let overlaps = false;
		for (let n = span.startLine; n <= span.endLine; n++)
			if (lines.has(n)) overlaps = true;
		if (overlaps) continue;
		for (let n = span.startLine; n <= span.endLine; n++) lines.add(n);
		taken.set(span.filename, lines);
		kept.push(op);
	}
	return kept;
}

function byTarget(a: Operation, b: Operation): number {
	const key = (op: Operation): [string, number, string, number] => [
		op.to[0]?.filename ?? "",
		op.to[0]?.startLine ?? 0,
		op.from[0]?.filename ?? "",
		op.from[0]?.startLine ?? 0,
	];
	const x = key(a);
	const y = key(b);
	return (
		x[0].localeCompare(y[0]) ||
		x[1] - y[1] ||
		x[2].localeCompare(y[2]) ||
		x[3] - y[3]
	);
}
