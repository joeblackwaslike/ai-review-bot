import type { Verdict } from "../feedback/types.js";

export type LedgerStatus =
	| "open"
	| "fixed"
	| "rejected"
	| "deferred"
	| "acknowledged"
	| "resolved";

export interface LedgerEntry {
	id: string;
	round: number;
	path: string | null;
	line: number | null;
	severity: string;
	title: string;
	body?: string | null;
	action?: string;
	fp?: string;
	sfp?: string;
	/** Posted by a quality or architecture agent; never blocks the verdict. */
	advisory?: true;
	/** Reaction verdicts on the posted comment, one per reactor. Set only for a comment carrying a single claim. */
	reactions?: Verdict[];
	status: LedgerStatus;
	decidedBy: "author" | "reviewer" | null;
	reason: string | null;
	evidence: string[];
}

export type Ledger = LedgerEntry[];

export const isAcknowledged = (e: LedgerEntry): boolean =>
	e.status === "acknowledged";

/** Closed by the author or the bot. An acknowledged entry is still open. */
export const isSettled = (e: LedgerEntry): boolean =>
	e.status !== "open" && e.status !== "acknowledged";
