export type SeverityFloor = "P3" | "P2" | "P1";

const DROPPED_BELOW: Record<SeverityFloor, readonly string[]> = {
	P3: [],
	P2: ["P3"],
	P1: ["P2", "P3"],
};

/** Splits findings by a severity floor. P0 and P1 are never dropped. */
export function applySeverityFloor<T extends { severity?: string | null }>(
	findings: T[],
	floor: SeverityFloor,
): { kept: T[]; dropped: T[] } {
	const below = DROPPED_BELOW[floor];
	const kept: T[] = [];
	const dropped: T[] = [];
	for (const f of findings)
		(f.severity != null && below.includes(f.severity) ? dropped : kept).push(f);
	return { kept, dropped };
}
