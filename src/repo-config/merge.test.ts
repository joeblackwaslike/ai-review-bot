import { describe, expect, it } from "vitest";
import type { ValueSource } from "../config/env.js";
import { ConfigSchema } from "../config/schema.js";
import { mergeRepoConfig } from "./merge.js";
import type { RepoConfig } from "./schema.js";

const tier = { model: "anthropic/claude-sonnet-5-5", effort: "high" };
const tiers = { trivial: tier, normal: tier, complex: tier, deep: tier };

const deployment = (
	review: Record<string, unknown> = {},
	reviewer: Record<string, unknown> = {},
	routing: Record<string, unknown> = {},
) =>
	ConfigSchema.parse({
		version: 1,
		models: { "anthropic/claude-sonnet-5-5": {} },
		reviewers: { claude: { tiers, ...reviewer } },
		review,
		routing,
	});

const merge = (
	repo: RepoConfig | undefined,
	opts: {
		dep?: ReturnType<typeof deployment>;
		sources?: Record<string, ValueSource>;
		reviewerId?: string;
	} = {},
) =>
	mergeRepoConfig({
		deployment: opts.dep ?? deployment(),
		sources: opts.sources ?? {},
		reviewerId: opts.reviewerId ?? "claude",
		repo,
	});

describe("mergeRepoConfig", () => {
	it("no repo file yields the deployment values (nothing disabled, floor from deployment)", () => {
		const out = merge(undefined, { dep: deployment({ minSeverity: "P2" }) });
		expect(out).toEqual({
			reviewerDisabled: false,
			runOn: undefined,
			disabledSkills: new Set(),
			extraSensitivePatterns: [],
			minSeverity: "P2",
			customPrompt: undefined,
			command: undefined,
		});
	});

	it("repo disable turns the reviewer off even when the deployment enables it", () => {
		const out = merge({
			version: 1,
			reviewers: { claude: { enabled: false } },
		});
		expect(out.reviewerDisabled).toBe(true);
	});

	it("repo cannot enable a deployment-disabled reviewer", () => {
		const out = merge(
			{ version: 1, reviewers: { claude: {} } },
			{ dep: deployment({}, { enabled: false }) },
		);
		expect(out.reviewerDisabled).toBe(true);
	});

	it("an unknown reviewer id yields reviewerDisabled true", () => {
		expect(merge(undefined, { reviewerId: "nope" }).reviewerDisabled).toBe(
			true,
		);
	});

	it("runOn is the intersection and an empty intersection disables the reviewer", () => {
		const dep = deployment({}, { runOn: ["normal", "complex"] });
		const some = merge(
			{ version: 1, reviewers: { claude: { runOn: ["complex", "deep"] } } },
			{ dep },
		);
		expect(some.runOn).toEqual(["complex"]);
		expect(some.reviewerDisabled).toBe(false);
		const none = merge(
			{ version: 1, reviewers: { claude: { runOn: ["trivial"] } } },
			{ dep },
		);
		expect(none.reviewerDisabled).toBe(true);
	});

	it("repo runOn alone restricts, and deployment runOn alone is kept", () => {
		expect(
			merge({ version: 1, reviewers: { claude: { runOn: ["deep"] } } }).runOn,
		).toEqual(["deep"]);
		expect(
			merge(undefined, { dep: deployment({}, { runOn: ["deep"] }) }).runOn,
		).toEqual(["deep"]);
	});

	it("minSeverity takes the stricter of deployment and repo", () => {
		const repo = (minSeverity: "P3" | "P2" | "P1"): RepoConfig => ({
			version: 1,
			review: { minSeverity },
		});
		const dep = deployment({ minSeverity: "P2" });
		expect(merge(repo("P1"), { dep }).minSeverity).toBe("P1");
		expect(merge(repo("P3"), { dep }).minSeverity).toBe("P2");
	});

	it("sensitive patterns are appended and deduplicated", () => {
		const dep = deployment({}, {}, { sensitivePathPatterns: ["auth"] });
		const out = merge(
			{
				version: 1,
				routing: { sensitivePathPatterns: ["Auth", "billing", "BILLING"] },
			},
			{ dep },
		);
		expect(out.extraSensitivePatterns).toEqual(["billing"]);
	});

	it("collects disabled skills", () => {
		const out = merge({
			version: 1,
			reviewers: {
				claude: { skills: { "code-reviewer": { enabled: false } } },
			},
		});
		expect([...out.disabledSkills]).toEqual(["code-reviewer"]);
	});

	it('a repo reviewer key like "__proto__" or "constructor" does not disable anything or throw', () => {
		const repo = JSON.parse(
			'{"version":1,"reviewers":{"__proto__":{"enabled":false},"constructor":{"enabled":false}}}',
		) as RepoConfig;
		expect(merge(repo, { reviewerId: "constructor" }).reviewerDisabled).toBe(
			true,
		);
		expect(merge(repo).reviewerDisabled).toBe(false);
	});

	it("customPrompt from the repo applies only when the deployment value came from yaml or default", () => {
		const repo: RepoConfig = { version: 1, review: { customPrompt: "hi" } };
		expect(
			merge(repo, { sources: { "review.customPrompt": "default" } })
				.customPrompt,
		).toBe("hi");
		expect(
			merge(repo, { sources: { "review.customPrompt": "yaml" } }).customPrompt,
		).toBe("hi");
	});

	it("env-sourced customPrompt wins over the repo", () => {
		const repo: RepoConfig = { version: 1, review: { customPrompt: "hi" } };
		for (const source of ["env", "alias"] as const) {
			expect(
				merge(repo, { sources: { "review.customPrompt": source } })
					.customPrompt,
			).toBeUndefined();
		}
	});

	it("command follows the same rule", () => {
		const repo: RepoConfig = { version: 1, review: { command: "/x" } };
		expect(merge(repo, { sources: { "review.command": "yaml" } }).command).toBe(
			"/x",
		);
		expect(
			merge(repo, { sources: { "review.command": "env" } }).command,
		).toBeUndefined();
	});
});
