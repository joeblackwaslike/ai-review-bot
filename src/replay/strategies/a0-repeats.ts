export const DEFAULT_TOLERANCE = 0.1;

/** The integer `n >= 1` whose `n * perRunUsd` is closest to `targetUsd`, capped at `max`. */
export function repeatsForBudget(args: {
	targetUsd: number;
	perRunUsd: number;
	tolerance: number;
	max: number;
}): number {
	const { targetUsd, perRunUsd, max } = args;
	if (!(perRunUsd > 0) || !(targetUsd > 0)) return 1;
	return Math.min(Math.max(1, Math.round(targetUsd / perRunUsd)), max);
}

export function withinTolerance(
	achievedUsd: number,
	targetUsd: number,
	tolerance: number,
): boolean {
	return (
		targetUsd > 0 &&
		Math.abs(achievedUsd - targetUsd) / targetUsd <= tolerance + 1e-9
	);
}
