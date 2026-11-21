const SPEND_MATCHED = new Set(["a0", "f0", "f1"]);

/** Strategies that repeat to match baseline `a`'s spend, so they run after `a` and need its cost. */
export const isSpendMatched = (name: string): boolean =>
	SPEND_MATCHED.has(name);

/** Usage key under which f1 records its triage call. */
export const TRIAGE_USAGE_KEY = "f1-triage.md";

/** Prefix of the toolCalls entry f1 records for its triage call. */
export const TRIAGE_CALL_PREFIX = "triage:";
