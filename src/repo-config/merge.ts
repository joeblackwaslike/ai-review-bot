import type { ValueSource } from "../config/env.js";
import type { Config } from "../config/schema.js";
import { SKILL_NAMES } from "../skill-names.js";
import type { RepoConfig } from "./schema.js";

type Tier = NonNullable<Config["reviewers"][string]["runOn"]>[number];
type MinSeverity = Config["review"]["minSeverity"];

export interface RepoOverrides {
	reviewerDisabled: boolean;
	runOn?: Tier[];
	disabledSkills: ReadonlySet<string>;
	extraSensitivePatterns: string[];
	minSeverity: MinSeverity;
	floorRaisedByRepo: boolean;
	customPrompt?: string;
	command?: string;
}

const SEVERITY_ORDER: readonly MinSeverity[] = ["P3", "P2", "P1"];

const repoMayOverride = (source: ValueSource | undefined): boolean =>
	source === "yaml" || source === "default";

export function mergeRepoConfig(args: {
	deployment: Config;
	sources: Record<string, ValueSource>;
	reviewerId: string;
	repo: RepoConfig | undefined;
}): RepoOverrides {
	const { deployment, sources, reviewerId, repo } = args;
	const reviewer = Object.hasOwn(deployment.reviewers, reviewerId)
		? deployment.reviewers[reviewerId]
		: undefined;
	const repoReviewer =
		repo?.reviewers && Object.hasOwn(repo.reviewers, reviewerId)
			? repo.reviewers[reviewerId]
			: undefined;

	let reviewerDisabled = !reviewer?.enabled;
	if (repoReviewer?.enabled === false) reviewerDisabled = true;

	let runOn: Tier[] | undefined = reviewer?.runOn;
	if (repoReviewer?.runOn) {
		const allowed = runOn;
		runOn = repoReviewer.runOn.filter((t) => !allowed || allowed.includes(t));
		if (runOn.length === 0) reviewerDisabled = true;
	}

	const disabledSkills = new Set(
		Object.keys(repoReviewer?.skills ?? {}).filter((n) => SKILL_NAMES.has(n)),
	);

	const known = new Set(
		deployment.routing.sensitivePathPatterns.map((p) => p.toLowerCase()),
	);
	const extraSensitivePatterns: string[] = [];
	for (const pattern of repo?.routing?.sensitivePathPatterns ?? []) {
		const key = pattern.toLowerCase();
		if (known.has(key)) continue;
		known.add(key);
		extraSensitivePatterns.push(pattern);
	}

	if (disabledSkills.size >= SKILL_NAMES.size) reviewerDisabled = true;

	const repoFloor = repo?.review?.minSeverity;
	const floorRaisedByRepo =
		!!repoFloor &&
		SEVERITY_ORDER.indexOf(repoFloor) >
			SEVERITY_ORDER.indexOf(deployment.review.minSeverity);
	const minSeverity =
		floorRaisedByRepo && repoFloor ? repoFloor : deployment.review.minSeverity;

	return {
		reviewerDisabled,
		runOn,
		disabledSkills,
		extraSensitivePatterns,
		minSeverity,
		floorRaisedByRepo,
		customPrompt: repoMayOverride(sources["review.customPrompt"])
			? repo?.review?.customPrompt
			: undefined,
		command: repoMayOverride(sources["review.command"])
			? repo?.review?.command
			: undefined,
	};
}

/** One fixed-text line for the review body when the repo file reduces coverage.
 * Built only from bare skill names in SKILL_NAMES and the floor value. */
export function repoCoverageNotice(
	overrides: RepoOverrides | undefined,
): string | null {
	if (!overrides) return null;
	const parts: string[] = [];
	if (overrides.disabledSkills.size > 0) {
		const names = [...overrides.disabledSkills].sort().join(", ");
		parts.push(`skills ${names} disabled`);
	}
	if (overrides.floorRaisedByRepo) {
		parts.push(`findings below ${overrides.minSeverity} are hidden`);
	}
	return parts.length === 0
		? null
		: `Repository override active: ${parts.join("; ")}.`;
}
