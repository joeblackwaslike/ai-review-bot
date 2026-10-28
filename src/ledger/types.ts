export type LedgerStatus =
	| "open"
	| "fixed"
	| "rejected"
	| "deferred"
	| "resolved";

export interface LedgerEntry {
	id: string;
	round: number;
	path: string | null;
	line: number | null;
	severity: string;
	title: string;
	action?: string;
	status: LedgerStatus;
	decidedBy: "author" | "reviewer" | null;
	reason: string | null;
	evidence: string[];
}

export type Ledger = LedgerEntry[];

export const isSettled = (e: LedgerEntry): boolean => e.status !== "open";
