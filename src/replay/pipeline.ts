import type { ClaimLabel, PostedClaim, Round } from "./types.js";

export interface LedgerView {
	priorClaims: PostedClaim[];
	labels: Map<string, ClaimLabel>;
}

export type ReplayPipeline = (input: {
	round: Round;
	claims: PostedClaim[];
	ledger: LedgerView;
}) => { posted: string[]; suppressed: string[] };

export const asRecordedPipeline: ReplayPipeline = ({ claims }) => ({
	posted: claims.map((c) => c.id),
	suppressed: [],
});

/** Interface check until sprint 2 wires in real suppression: posts everything. */
export const todaysCodePipeline: ReplayPipeline = (input) =>
	asRecordedPipeline(input);
