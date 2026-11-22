import type { PushFile } from "../moved-blocks.js";
import { verifyCopy } from "./copy-check.js";
import { buildPrFacts } from "./facts.js";
import { buildFileNodes } from "./files.js";
import { findMechanical, findRenames } from "./operations.js";
import { findRelocations } from "./relocation.js";
import { verifyRelocation } from "./relocation-check.js";
import type { DiffModel } from "./types.js";

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
		...copies.filter((op) => verifyCopy(op, scopeFiles, verifiedRelocations)),
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
