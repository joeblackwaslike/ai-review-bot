import { runAuditPass } from "../audit.js";
import {
	type ResolvedAuth,
	resolveAnthropicAuth,
	resolveOpenAIAuth,
} from "../auth.js";
import { providerKeySpec, readSecret } from "../config/env.js";
import { computeCost } from "../models.js";
import type { ProviderName } from "../providers/names.js";
import type { ModelReview } from "../review.js";
import { routeReviewerModel } from "../router.js";
import type { GhClient } from "./gh.js";
import type { LiveFinding, LiveOptions } from "./live.js";
import { fixtureReviewer, type ReplayFixture } from "./types.js";

const AGENTS_PER_REVIEW = 5;
const CHARS_PER_TOKEN = 4;
const EXPECTED_COMPLETION_TOKENS = 2000;

interface CompareResponse {
	files?: { filename: string; patch?: string }[];
}

export function toLiveFindings(review: ModelReview): LiveFinding[] {
	return [
		...review.inline_comments.map((c) => ({
			title: c.title,
			path: c.path,
			line: c.line,
			body: c.body,
			severity: c.severity,
			suppressible: c.suppressible,
		})),
		...review.general_findings.map((g) => ({
			title: g.title,
			path: null,
			line: null,
			body: g.body,
			severity: g.severity,
			suppressible: g.suppressible,
		})),
	];
}

interface SelectionAuthResolvers {
	anthropic: () => Promise<ResolvedAuth>;
	openai: () => Promise<ResolvedAuth>;
}

const SUBSCRIPTION_RESOLVERS: SelectionAuthResolvers = {
	anthropic: () => resolveAnthropicAuth(),
	openai: () => resolveOpenAIAuth(),
};

export async function resolveSelectionAuth(
	provider: ProviderName,
	resolvers: SelectionAuthResolvers = SUBSCRIPTION_RESOLVERS,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedAuth | undefined> {
	if (provider === "anthropic") return resolvers.anthropic();
	if (provider === "openai") return resolvers.openai();
	const spec = providerKeySpec(provider);
	if (readSecret(spec, env).value === undefined) {
		throw new Error(
			`replay --live needs ${spec.aliases[0]?.name ?? spec.envName} for the ${provider} provider`,
		);
	}
	return undefined;
}

type LiveWiring = Pick<LiveOptions, "review" | "estimateCost" | "fetchDiff">;

/** Real review, cost estimate, and diff fetch for `replay --live`. Needs local auth. */
export function buildLiveWiring(
	fixture: ReplayFixture,
	client: GhClient,
): LiveWiring {
	const meta = { owner: fixture.owner, repo: fixture.repo, ref: "replay" };
	const { selection } = routeReviewerModel(
		{ additions: 0, deletions: 0, filePaths: [], labels: [] },
		fixtureReviewer(fixture),
	);
	return {
		fetchDiff: async (round) => {
			const base = round.mergeBase ?? round.baseSha;
			const cmp = await client.rest<CompareResponse>(
				`repos/${fixture.owner}/${fixture.repo}/compare/${base}...${round.headSha}`,
			);
			const files = (cmp.files ?? []).map((f) => ({
				filename: f.filename,
				patch: f.patch ?? "",
			}));
			return {
				diff: files.map((f) => `--- ${f.filename}\n${f.patch}`).join("\n"),
				approximate: round.approximate || round.mergeBase === null,
			};
		},
		estimateCost: (diff) =>
			computeCost(
				{
					promptTokens: (diff.length / CHARS_PER_TOKEN) * AGENTS_PER_REVIEW,
					completionTokens: EXPECTED_COMPLETION_TOKENS * AGENTS_PER_REVIEW,
				},
				selection.model,
			),
		review: async (diff): Promise<LiveFinding[]> => {
			const auth = await resolveSelectionAuth(selection.provider);
			const { review } = await runAuditPass({
				files: [{ path: "replay.diff", content: diff }],
				selection,
				extraInstructions: "",
				meta,
				auth,
			});
			return toLiveFindings(review);
		},
	};
}
