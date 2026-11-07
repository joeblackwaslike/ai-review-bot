import { describe, expect, it } from "vitest";
import { loadConfig } from "./config/load.js";
import { type Config, ConfigSchema } from "./config/schema.js";
import type { ProviderName } from "./providers/names.js";
import {
	DEFAULT_JUDGE,
	type ReviewerRoleName,
	resolveJudgeRole,
	resolveReviewerRole,
	resolveVerifier,
} from "./roles.js";
import { cheapSelection, type ModelSelection } from "./router.js";

const base = loadConfig({ env: {} }).config;
const reviewerId = Object.keys(base.reviewers)[0] as string;

function withRoles(
	roles: Partial<Config["roles"]>,
	reviewerRoles?: Config["reviewers"][string]["roles"],
): Config {
	const reviewer = base.reviewers[reviewerId] as Config["reviewers"][string];
	return {
		...base,
		roles: { ...roles },
		reviewers: {
			...base.reviewers,
			[reviewerId]: { ...reviewer, roles: reviewerRoles },
		},
	};
}

const finders: ModelSelection[] = [
	{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
	{ provider: "openai", model: "gpt-6", effort: "medium" },
	{ provider: "google", model: "gemini-3-pro", effort: "high" },
];

describe("resolveReviewerRole defaults", () => {
	const empty = withRoles({});
	it.each(finders)("summary keeps the finder model ($provider)", (finder) => {
		expect(resolveReviewerRole(empty, reviewerId, "summary", finder)).toEqual(
			finder,
		);
	});
	it.each(
		finders,
	)("triage and revalidate use cheapSelection ($provider)", (finder) => {
		for (const role of ["triage", "revalidate"] as const) {
			expect(resolveReviewerRole(empty, reviewerId, role, finder)).toEqual(
				cheapSelection(finder),
			);
		}
	});
	it("cheapSelection values are exact", () => {
		expect(cheapSelection(finders[0] as ModelSelection)).toEqual({
			provider: "anthropic",
			model: "claude-haiku-5-5",
			effort: "low",
		});
		expect(cheapSelection(finders[2] as ModelSelection)).toEqual({
			provider: "google",
			model: "gemini-3-pro",
			effort: "low",
		});
	});
});

describe("resolveReviewerRole precedence", () => {
	const finder = finders[0] as ModelSelection;
	it.each([
		"summary",
		"triage",
		"revalidate",
	] as ReviewerRoleName[])("applies a reviewer-level %s role when top-level is empty", (role) => {
		const cfg = withRoles({}, { [role]: { model: "google/gemini-3-pro" } });
		expect(resolveReviewerRole(cfg, reviewerId, role, finder)).toEqual({
			provider: "google",
			model: "gemini-3-pro",
		});
	});
	it.each([
		"summary",
		"triage",
		"revalidate",
	] as ReviewerRoleName[])("reviewer beats top-level beats default for %s", (role) => {
		const top = { model: "openai/gpt-6", effort: "high" as const };
		const own = { model: "google/gemini-3-pro" };
		const topOnly = withRoles({ [role]: top });
		expect(resolveReviewerRole(topOnly, reviewerId, role, finder)).toEqual({
			provider: "openai",
			model: "gpt-6",
			effort: "high",
		});
		const both = withRoles({ [role]: top }, { [role]: own });
		expect(resolveReviewerRole(both, reviewerId, role, finder)).toEqual({
			provider: "google",
			model: "gemini-3-pro",
		});
	});
});

describe("resolveJudgeRole", () => {
	it("defaults to DEFAULT_JUDGE", () => {
		expect(DEFAULT_JUDGE).toEqual({
			provider: "anthropic",
			model: "claude-haiku-5-5",
			effort: "low",
		});
		expect(resolveJudgeRole(withRoles({}), "qcJudge")).toEqual(DEFAULT_JUDGE);
		expect(resolveJudgeRole(withRoles({}), "classifier")).toEqual(
			DEFAULT_JUDGE,
		);
	});
	it("returns the configured entry", () => {
		const cfg = withRoles({
			qcJudge: { model: "openai/gpt-6", effort: "medium" },
			classifier: { model: "google/gemini-3-pro" },
		});
		expect(resolveJudgeRole(cfg, "qcJudge")).toEqual({
			provider: "openai",
			model: "gpt-6",
			effort: "medium",
		});
		expect(resolveJudgeRole(cfg, "classifier")).toEqual({
			provider: "google",
			model: "gemini-3-pro",
		});
	});
});

describe("resolveVerifier", () => {
	const finder = finders[0] as ModelSelection;
	const verifier = {
		model: "openai/gpt-6",
		effort: "high" as const,
		enabled: true,
	};
	const both: ProviderName[] = ["anthropic", "openai"];
	it("is null without an entry", () => {
		expect(resolveVerifier(withRoles({}), finder, both)).toBeNull();
	});
	it("is null when disabled", () => {
		const cfg = withRoles({ verifier: { ...verifier, enabled: false } });
		expect(resolveVerifier(cfg, finder, both)).toBeNull();
	});
	it("is null when differentFrom finder and only the finder provider exists", () => {
		const cfg = withRoles({
			verifier: { ...verifier, differentFrom: "finder" },
		});
		expect(resolveVerifier(cfg, finder, ["anthropic"])).toBeNull();
	});
	it("is null when differentFrom finder and the verifier shares the finder provider", () => {
		const cfg = withRoles({
			verifier: {
				model: "anthropic/claude-opus-5-5",
				enabled: true,
				differentFrom: "finder",
			},
		});
		expect(resolveVerifier(cfg, finder, both)).toBeNull();
	});
	it("is null when the verifier provider is not configured", () => {
		const cfg = withRoles({
			verifier: { ...verifier, model: "google/gemini-3-pro" },
		});
		expect(resolveVerifier(cfg, finder, both)).toBeNull();
	});
	it("resolves a verifier with enabled omitted (schema defaults it to true)", () => {
		const parsed = ConfigSchema.parse({
			...base,
			roles: { verifier: { model: "openai/gpt-6" } },
		});
		expect(resolveVerifier(parsed, finder, both)).toEqual({
			provider: "openai",
			model: "gpt-6",
		});
	});
	it("returns the model when a different provider is available", () => {
		const cfg = withRoles({
			verifier: { ...verifier, differentFrom: "finder" },
		});
		expect(resolveVerifier(cfg, finder, both)).toEqual({
			provider: "openai",
			model: "gpt-6",
			effort: "high",
		});
	});
});
