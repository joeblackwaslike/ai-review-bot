import { generateObject } from "ai";
import { z } from "zod";
import { createAIModel } from "./models.js";
import type { PersistedFinding } from "./review-state.js";
import type { ModelSelection } from "./router.js";

export const TriageSchema = z.object({
	recommendation: z.enum(["SKIP", "INCREMENTAL", "FULL"]),
	resolved: z.array(z.string()),
	newRisk: z.boolean(),
});

export type TriageDecision = z.infer<typeof TriageSchema>;

const FAIL_SAFE: TriageDecision = {
	recommendation: "INCREMENTAL",
	resolved: [],
	newRisk: true,
};

// Cheap, fast triage tier. The call only classifies; it does not review.
function triageSelection(base: ModelSelection): ModelSelection {
	return base.provider === "openai"
		? { provider: "openai", model: "gpt-5.1", effort: "low" }
		: { provider: "anthropic", model: "claude-haiku-4-5" };
}

export async function triageReReview(
	selection: ModelSelection,
	deltaDiff: string,
	openFindings: PersistedFinding[],
): Promise<TriageDecision> {
	if (openFindings.length === 0 && deltaDiff.trim() === "") {
		return { recommendation: "SKIP", resolved: [], newRisk: false };
	}
	const prompt = [
		"You are triaging whether an AI code reviewer needs to re-review a pull request after a new push.",
		"",
		"Your OPEN findings from the previous review (id — title):",
		...openFindings.map((f) => `- ${f.id} — ${f.title} [${f.severity}]`),
		"",
		"The diff added since your last review (delta only):",
		deltaDiff || "[no code changes in the delta]",
		"",
		"Decide:",
		"- resolved: ids of your open findings that this delta clearly fixes.",
		"- newRisk: true if the delta introduces new code that warrants review.",
		"- recommendation: SKIP if the delta neither touches your findings nor adds reviewable risk (e.g. it addresses another reviewer's feedback); INCREMENTAL if it resolves findings or adds modest new code; FULL only if it is a structural/architectural change.",
	].join("\n");

	try {
		const { object } = await generateObject({
			model: createAIModel(triageSelection(selection)),
			schema: TriageSchema,
			prompt,
			maxOutputTokens: 2000,
		});
		return object;
	} catch (err) {
		console.error("triage call failed; failing safe to INCREMENTAL", { err });
		return FAIL_SAFE;
	}
}

export async function fetchDelta(
	octokit: {
		request: (
			route: string,
			params: Record<string, unknown>,
		) => Promise<{ data: unknown }>;
	},
	owner: string,
	repo: string,
	baseSha: string,
	headSha: string,
): Promise<string> {
	const res = await octokit.request(
		"GET /repos/{owner}/{repo}/compare/{basehead}",
		{ owner, repo, basehead: `${baseSha}...${headSha}` },
	);
	const data = res.data as {
		files?: Array<{ filename: string; patch?: string }>;
	};
	return (data.files ?? [])
		.map((f) => `FILE: ${f.filename}\n${f.patch ?? "[no patch]"}`)
		.join("\n\n---\n\n");
}
