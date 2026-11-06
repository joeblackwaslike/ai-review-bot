import type { Verdict } from "./feedback/types.js";
import type { Ledger, LedgerEntry } from "./ledger/types.js";
import { ADAPTIVE_LIMIT_BANDS } from "./reviewer-tuning.js";

/** Finding severity, P0 most severe. */
export type Sev = "P0" | "P1" | "P2" | "P3";

/** Numeric severity rank; higher is more severe. */
export const SEV_RANK: Record<Sev, number> = { P0: 4, P1: 3, P2: 2, P3: 1 };

/** How the author responded to a finding. */
export type AuthorResponse =
	| "accepted"
	| "rejected"
	| "deferred"
	| "unanswered";

/** Rejection share of one earlier round, with its age relative to the current round. */
export interface RoundFriction {
	round: number;
	age: number;
	friction: number;
	answered: number;
}

/** Reads how the author responded to one finding. A settled status wins over reactions. */
export function classifyFinding(
	entry: LedgerEntry,
	reactions: Verdict[],
): AuthorResponse {
	switch (entry.status) {
		case "fixed":
		case "resolved":
		case "acknowledged":
			return entry.decidedBy === "author" ? "accepted" : "unanswered";
		case "rejected":
			return "rejected";
		case "deferred":
			return "deferred";
		case "open":
			if (reactions.includes("down")) return "rejected";
			if (reactions.includes("up")) return "accepted";
			return "unanswered";
	}
}

/** Friction per earlier round (share of answered findings rejected, deferred at half
 * weight), averaged with weight `decay^age`. `currentRound` is the number of earlier
 * own reviews. Returns a null score when no round has an answered finding. */
export function scoreTrajectory(
	entries: Ledger,
	reactionsFor: (e: LedgerEntry) => Verdict[],
	currentRound: number,
): { score: number | null; rounds: RoundFriction[] } {
	const { decay, deferredWeight } = ADAPTIVE_LIMIT_BANDS;
	const byRound = new Map<number, AuthorResponse[]>();
	for (const e of entries) {
		if (e.round >= currentRound) continue;
		const list = byRound.get(e.round) ?? [];
		list.push(classifyFinding(e, reactionsFor(e)));
		byRound.set(e.round, list);
	}
	const rounds: RoundFriction[] = [];
	for (const [round, outcomes] of [...byRound].sort((a, b) => a[0] - b[0])) {
		const count = (o: AuthorResponse) => outcomes.filter((x) => x === o).length;
		const answered = outcomes.length - count("unanswered");
		if (answered === 0) continue;
		const friction =
			(count("rejected") + deferredWeight * count("deferred")) / answered;
		rounds.push({ round, age: currentRound - 1 - round, friction, answered });
	}
	let num = 0;
	let den = 0;
	for (const r of rounds) {
		const w = decay ** r.age;
		num += w * r.friction;
		den += w;
	}
	return {
		score: den === 0 ? null : num / den,
		rounds,
	};
}

/** Maps a trajectory score to the severity floor and findings budget to apply. */
export function limitsForScore(score: number | null): {
	floor: Sev | null;
	budget: number | null;
} {
	if (score === null) return { floor: null, budget: null };
	const { edges, budgets, floors } = ADAPTIVE_LIMIT_BANDS;
	const band = edges.filter((edge) => score >= edge).length;
	return { floor: floors[band] ?? null, budget: budgets[band] ?? null };
}
