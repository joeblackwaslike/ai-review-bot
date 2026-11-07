import type { Config } from "./config/schema.js";
import { type ProviderName, splitModelId } from "./providers/names.js";
import { cheapSelection, type ModelSelection } from "./router.js";

export type ReviewerRoleName = "summary" | "triage" | "revalidate";

export const DEFAULT_JUDGE: ModelSelection = {
	provider: "anthropic",
	model: "claude-haiku-5-5",
	effort: "low",
};

interface RoleChoice {
	model: string;
	effort?: ModelSelection["effort"];
}

function toSelection(choice: RoleChoice): ModelSelection {
	const { provider, model } = splitModelId(choice.model);
	return choice.effort === undefined
		? { provider, model }
		: { provider, model, effort: choice.effort };
}

/**
 * Model for a reviewer's non-finder role: the reviewer's own entry, then the
 * deployment-wide entry, then today's derivation (finder for summary,
 * `cheapSelection(finder)` for triage and revalidate).
 */
export function resolveReviewerRole(
	config: Config,
	reviewerId: string,
	role: ReviewerRoleName,
	finder: ModelSelection,
): ModelSelection {
	const choice =
		config.reviewers[reviewerId]?.roles?.[role] ?? config.roles[role];
	if (choice) return toSelection(choice);
	return role === "summary" ? finder : cheapSelection(finder);
}

/** Model for a deployment-wide judge role; `DEFAULT_JUDGE` when unset. */
export function resolveJudgeRole(
	config: Config,
	role: "qcJudge" | "classifier",
): ModelSelection {
	const choice = config.roles[role];
	return choice ? toSelection(choice) : DEFAULT_JUDGE;
}

/**
 * Verifier model, or null when absent, disabled, its provider is not
 * configured, or `differentFrom: finder` cannot be met (the verifier shares
 * the finder's provider, or every configured provider is the finder's).
 */
export function resolveVerifier(
	config: Config,
	finder: ModelSelection,
	configuredProviders: readonly ProviderName[],
): ModelSelection | null {
	const verifier = config.roles.verifier;
	if (!verifier?.enabled) return null;
	const selection = toSelection(verifier);
	if (!configuredProviders.includes(selection.provider)) return null;
	if (
		verifier.differentFrom === "finder" &&
		selection.provider === finder.provider
	) {
		return null;
	}
	return selection;
}
