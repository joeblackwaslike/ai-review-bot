import { generateObject } from "ai";
import { z } from "zod";
import type { ResolvedAuth } from "./auth.js";
import { createAIModel } from "./models.js";
import { trimPatch } from "./prompt.js";
import type { PersistedFinding } from "./review-state.js";
import {
	type ModelSelection,
	outputBudget,
	reasoningProviderOptions,
} from "./router.js";

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

/** Builds the per-call schema for the triage decision. `resolved` is
 * constrained to an enum of the actual open-finding ids (or forced empty when
 * there are none) instead of a free-form `z.array(z.string())`. The prompt
 * shows each finding as `id — title`, so a model naturally echoes that whole
 * line back; without this constraint the echoed string silently fails the
 * exact-match lookup in the resolution loop below, keeping a
 * genuinely-resolved finding permanently marked open. */
function buildTriageSchema(openFindings: PersistedFinding[]) {
	// Deduplicated: an enum should represent distinct choices regardless of
	// what any particular zod version tolerates at runtime.
	const ids = [...new Set(openFindings.map((f) => f.id))];
	return z.object({
		recommendation: z.enum(["SKIP", "INCREMENTAL", "FULL"]),
		resolved:
			ids.length > 0
				? z.array(z.enum(ids as [string, ...string[]]))
				: z.array(z.string()).length(0),
		newRisk: z.boolean(),
	});
}

// Cheap, fast triage tier. The call only classifies; it does not review.
// Both models are confirmed on the API-key and OAuth/subscription backends.
function triageSelection(base: ModelSelection): ModelSelection {
	return base.provider === "openai"
		? { provider: "openai", model: "gpt-6-luna", effort: "low" }
		: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low" };
}

export async function triageReReview(
	selection: ModelSelection,
	deltaDiff: string,
	openFindings: PersistedFinding[],
	auth?: ResolvedAuth,
	mode: "delta" | "current" = "delta",
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
		mode === "current"
			? "The current patches of the files your open findings name:"
			: "The diff added since your last review (delta only):",
		deltaDiff || "[no code changes in the delta]",
		"",
		"Decide:",
		"- resolved: ids of your open findings that this delta clearly fixes.",
		"- newRisk: true if the delta introduces new code that warrants review.",
		"- recommendation: SKIP if the delta neither touches your findings nor adds reviewable risk (e.g. it addresses another reviewer's feedback); INCREMENTAL if it resolves findings or adds modest new code; FULL only if it is a structural/architectural change.",
	].join("\n");

	try {
		const triage = triageSelection(selection);
		const { object } = await generateObject({
			model: createAIModel(triage, auth),
			schema: buildTriageSchema(openFindings),
			prompt,
			maxOutputTokens: outputBudget(triage, 2000),
			providerOptions: reasoningProviderOptions(triage),
		});
		return object;
	} catch (err) {
		console.error("triage call failed; failing safe to INCREMENTAL", { err });
		return FAIL_SAFE;
	}
}

const REVALIDATE_CHAR_CAP = 60000;

/** Asks the triage model which carried findings the current patches fix.
 * Only findings with a `path` whose file is in `files` are sent, with those
 * files' patches capped at 60,000 characters in total. Returns resolved ids;
 * `[]` when nothing is sendable or the model call fails. */
export async function revalidateFindings(
	selection: ModelSelection,
	carried: PersistedFinding[],
	files: DeltaFile[],
	auth?: ResolvedAuth,
): Promise<string[]> {
	const byName = new Map(files.map((f) => [f.filename, f]));
	const sent = new Map<string, string>();
	let used = 0;
	for (const f of carried) {
		if (!f.path || sent.has(f.path)) continue;
		const file = byName.get(f.path);
		if (!file) continue;
		const block = `FILE: ${file.filename}\n${trimPatch(file.patch ?? "[no patch]")}`;
		if (used + block.length > REVALIDATE_CHAR_CAP) continue;
		sent.set(f.path, block);
		used += block.length;
	}
	const sendable = carried.filter((f) => f.path && sent.has(f.path));
	if (sendable.length === 0) return [];

	const ids = [...new Set(sendable.map((f) => f.id))] as [string, ...string[]];
	const prompt = [
		"You are checking whether an AI code reviewer's earlier findings are fixed in the current code.",
		"",
		"Your carried findings (id — title):",
		...sendable.map((f) => `- ${f.id} — ${f.title} [${f.severity}]`),
		"",
		"The current patches of the files your findings name:",
		...sent.values(),
		"",
		"resolved: ids of findings that these patches clearly fix. Leave out anything uncertain.",
	].join("\n");

	try {
		const triage = triageSelection(selection);
		const { object } = await generateObject({
			model: createAIModel(triage, auth),
			schema: z.object({ resolved: z.array(z.enum(ids)) }),
			prompt,
			maxOutputTokens: outputBudget(triage, 2000),
			providerOptions: reasoningProviderOptions(triage),
		});
		return object.resolved;
	} catch (err) {
		console.error("revalidation call failed; resolving nothing", { err });
		return [];
	}
}

interface CompareOctokit {
	request: <T>(
		route: string,
		params: Record<string, string | number>,
	) => Promise<{ data: T }>;
}

export interface DeltaFile {
	filename: string;
	status: string;
	patch?: string;
}

export interface DeltaMeta {
	files: DeltaFile[];
	diff: string;
	truncated: boolean;
	status: string;
}

/** The GitHub compare API caps `.files` at this many entries with no pagination
 * and no explicit truncation flag. When the array hits this length the response
 * is silently incomplete — downstream triage/INCREMENTAL logic would reason over
 * partial data. */
export const COMPARE_FILE_CAP = 300;

/** Returns true when the compare-API file list is likely truncated (hit the cap). */
export function isLikelyTruncated(files: DeltaFile[]): boolean {
	return files.length >= COMPARE_FILE_CAP;
}

async function fetchCompareFiles(
	octokit: CompareOctokit,
	owner: string,
	repo: string,
	baseSha: string,
	headSha: string,
): Promise<{ files: DeltaFile[]; status?: string }> {
	const res = await octokit.request(
		"GET /repos/{owner}/{repo}/compare/{basehead}",
		{ owner, repo, basehead: `${baseSha}...${headSha}` },
	);
	const data = res.data as { files?: DeltaFile[]; status?: string };
	return { files: data.files ?? [], status: data.status };
}

/** Fetches the compare-API result and returns files, a unified diff string, and
 * a truncation flag. Use this in the triage gate so both the delta diff and the
 * truncation signal come from a single API call. */
export async function fetchDeltaMeta(
	octokit: CompareOctokit,
	owner: string,
	repo: string,
	baseSha: string,
	headSha: string,
): Promise<DeltaMeta | null> {
	let compare: Awaited<ReturnType<typeof fetchCompareFiles>>;
	try {
		compare = await fetchCompareFiles(octokit, owner, repo, baseSha, headSha);
	} catch (err) {
		console.warn("compare request failed; delta unusable", {
			reason: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	if (compare.status !== "ahead") {
		console.warn("compare status is not ahead; delta unusable", {
			status: compare.status,
		});
		return null;
	}
	const { files, status } = compare;
	const diff = files
		.map((f) => `FILE: ${f.filename}\n${f.patch ?? "[no patch]"}`)
		.join("\n\n---\n\n");
	return { files, diff, truncated: isLikelyTruncated(files), status };
}

export async function fetchDelta(
	octokit: CompareOctokit,
	owner: string,
	repo: string,
	baseSha: string,
	headSha: string,
): Promise<string> {
	const { files } = await fetchCompareFiles(
		octokit,
		owner,
		repo,
		baseSha,
		headSha,
	);
	return files
		.map((f) => `FILE: ${f.filename}\n${f.patch ?? "[no patch]"}`)
		.join("\n\n---\n\n");
}

/** Raw compare-API files for the delta — same shape as the PR `files` array
 * buildReview consumes (filename/status/patch). Used for the INCREMENTAL path,
 * where agents review only the files changed since the last review. */
export async function fetchDeltaFiles(
	octokit: CompareOctokit,
	owner: string,
	repo: string,
	baseSha: string,
	headSha: string,
): Promise<DeltaFile[]> {
	return (await fetchCompareFiles(octokit, owner, repo, baseSha, headSha))
		.files;
}
