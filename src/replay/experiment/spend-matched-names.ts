const SPEND_MATCHED = new Set(["a0", "f0", "f1"]);

/** Strategies that repeat to match baseline `a`'s spend, so they run after `a` and need its cost. */
export const isSpendMatched = (name: string): boolean =>
	SPEND_MATCHED.has(name);
