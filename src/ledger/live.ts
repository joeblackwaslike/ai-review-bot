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
	reviewIds: number[];
}

export const LEDGER_TIMEOUT_MS = 15_000;

/** Never throws: a ledger that cannot be built within LEDGER_TIMEOUT_MS suppresses nothing. */
export async function loadLedger(
	octokit: RequestLike,
	o: {
		owner: string;
		repo: string;
		pull: number;
		commentPrefix: string;
		provider: string;
	},
): Promise<LoadedLedger> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(`ledger fetch timed out after ${LEDGER_TIMEOUT_MS}ms`),
				),
			LEDGER_TIMEOUT_MS,
		);
	});
	try {
		const evidence = await Promise.race([
			fetchLedgerEvidence(octokit, o),
			timeout,
		]);
		return {
			ledger: buildLedger(evidence),
			warm: true,
			reviewIds: evidence.reviewIds,
		};
	} catch (err) {
		console.warn("ledger unavailable; suppressing nothing this round", {
			owner: o.owner,
			repo: o.repo,
			pull: o.pull,
			error: err instanceof Error ? err.message : String(err),
		});
		return { ledger: [], warm: false, reviewIds: [] };
	} finally {
		clearTimeout(timer);
	}
}

export function reconcileSurvivingPrior(
	prior: PersistedFinding[],
	ledger: Ledger,
): PersistedFinding[] {
	return prior.filter((f) => !findSettledMatch(f, ledger));
}
