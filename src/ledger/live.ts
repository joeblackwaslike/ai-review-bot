import type { PersistedFinding } from "../review-state.js";
import {
	buildLedger,
	fetchLedgerEvidence,
	type RequestLike,
} from "./github.js";
import { findSettledMatch } from "./match.js";
import type { Ledger } from "./types.js";

export interface LoadedLedger {
	ledger: Ledger;
	warm: boolean;
}

/** Never throws: a ledger that cannot be built suppresses nothing. */
export async function loadLedger(
	octokit: RequestLike,
	o: { owner: string; repo: string; pull: number; commentPrefix: string },
): Promise<LoadedLedger> {
	try {
		const evidence = await fetchLedgerEvidence(octokit, o);
		return { ledger: buildLedger(evidence), warm: true };
	} catch (err) {
		console.warn("ledger unavailable; suppressing nothing this round", {
			owner: o.owner,
			repo: o.repo,
			pull: o.pull,
			error: err instanceof Error ? err.message : String(err),
		});
		return { ledger: [], warm: false };
	}
}

export function reconcileSurvivingPrior(
	prior: PersistedFinding[],
	ledger: Ledger,
): PersistedFinding[] {
	return prior.filter((f) => !findSettledMatch(f, ledger));
}
