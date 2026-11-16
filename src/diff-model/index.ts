import type { PushFile } from "../moved-blocks.js";
import { buildPrFacts } from "./facts.js";
import { buildFileNodes } from "./files.js";
import { findMechanical, findRenames } from "./operations.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation } from "./relocation-check.js";
import type { DiffModel } from "./types.js";

/**
 * Builds the model of a push. Operations come from `scopeFiles`, facts from `prFiles`.
 * A relocation the independent checker rejects is dropped and counted in `droppedClaims`.
 */
export function buildDiffModel(input: {
	scopeFiles: PushFile[];
	prFiles: PushFile[];
	prFilesComplete: boolean;
	title: string;
	body: string | null;
}): DiffModel {
	const { scopeFiles } = input;
	const relocations = findRelocations(scopeFiles);
	const verified = relocations.filter((op) => verifyRelocation(op, scopeFiles));
	return {
		files: buildFileNodes(scopeFiles),
		operations: [
			...verified,
			...findRenames(scopeFiles),
			...findMechanical(scopeFiles),
		],
		facts: buildPrFacts(input),
		droppedClaims: relocations.length - verified.length,
	};
}
