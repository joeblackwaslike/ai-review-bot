import { createHash } from "node:crypto";

export type Split = "tuning" | "validation" | "test";

export const MIN_PRS = 30;
export const MIN_PER_SPLIT = 10;
export const MIN_REPOS = 5;

/** `owner/repo#pull`, without any `@provider` suffix. */
export const prOf = (fixtureId: string): string =>
	fixtureId.replace(/@(anthropic|openai)$/, "");

export function splitOf(fixtureId: string, seed: string): Split {
	const hex = createHash("sha256")
		.update(seed + prOf(fixtureId))
		.digest("hex")
		.slice(0, 8);
	const unit = Number.parseInt(hex, 16) / 2 ** 32;
	if (unit < 1 / 3) return "tuning";
	if (unit < 2 / 3) return "validation";
	return "test";
}

interface FixtureRef {
	id: string;
	split: Split;
}

export function splitCounts(plan: {
	fixtures: FixtureRef[];
}): Record<Split, number> & { repos: number } {
	const counts = { tuning: 0, validation: 0, test: 0 };
	const repos = new Set<string>();
	const seen = new Set<string>();
	for (const f of plan.fixtures) {
		const pr = prOf(f.id);
		if (seen.has(pr)) continue;
		seen.add(pr);
		counts[f.split]++;
		repos.add(pr.split("#")[0] as string);
	}
	return { ...counts, repos: repos.size };
}

export function isDirectional(plan: { fixtures: FixtureRef[] }): boolean {
	const c = splitCounts(plan);
	return (
		new Set(plan.fixtures.map((f) => prOf(f.id))).size < MIN_PRS ||
		c.tuning < MIN_PER_SPLIT ||
		c.validation < MIN_PER_SPLIT ||
		c.test < MIN_PER_SPLIT ||
		c.repos < MIN_REPOS
	);
}
