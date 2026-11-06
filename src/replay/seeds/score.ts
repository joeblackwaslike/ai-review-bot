import type { Seed } from "./schema.js";

export interface SeedFinding {
	path: string | null;
	line: number | null;
	title: string;
}

export interface SeedOutcome {
	outcome: "found" | "false-positive" | "missed" | "clean-ok";
	foundDefect: boolean;
	extraFindings: number;
}

export interface SeedGate {
	pass: boolean;
	originalsMissed: number;
	cleanFindings: number;
	reasons: string[];
}

/** Exact scoring by path and inclusive line range; findings without a path or line never hit. */
export function scoreSeed(seed: Seed, findings: SeedFinding[]): SeedOutcome {
	if (seed.truth.clean) {
		return {
			outcome: findings.length === 0 ? "clean-ok" : "false-positive",
			foundDefect: false,
			extraFindings: findings.length,
		};
	}
	const { path, startLine, endLine } = seed.truth.defects[0];
	const hits = findings.filter(
		(f) =>
			f.path === path &&
			f.line !== null &&
			f.line >= startLine &&
			f.line <= endLine,
	).length;
	const foundDefect = hits > 0;
	const extraFindings = findings.length - (foundDefect ? 1 : 0);
	if (foundDefect) return { outcome: "found", foundDefect, extraFindings };
	return {
		outcome: findings.length === 0 ? "missed" : "false-positive",
		foundDefect,
		extraFindings,
	};
}

/**
 * Spec section 9: a strategy that misses more than one original, or posts any finding on any
 * clean control, does not go forward. A defect seed whose only findings are elsewhere counts as
 * missed. Variants do not affect the gate.
 */
export function seedGate(
	results: { seed: Seed; outcome: SeedOutcome }[],
): SeedGate {
	const originalsMissed = results.filter(
		(r) =>
			r.seed.variant === "original" &&
			!r.seed.truth.clean &&
			!r.outcome.foundDefect,
	).length;
	const cleanFindings = results
		.filter((r) => r.seed.truth.clean)
		.reduce((sum, r) => sum + r.outcome.extraFindings, 0);
	const reasons: string[] = [];
	if (originalsMissed > 1)
		reasons.push(`${originalsMissed} of the originals were missed (limit 1)`);
	if (cleanFindings > 0)
		reasons.push(`${cleanFindings} finding(s) posted on clean controls`);
	return {
		pass: reasons.length === 0,
		originalsMissed,
		cleanFindings,
		reasons,
	};
}
