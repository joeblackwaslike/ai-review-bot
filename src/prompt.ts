import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));

function loadSkill(relativePath: string): string {
	const raw = readFileSync(`${skillsDir}/${relativePath}`, "utf8");
	// Strip YAML frontmatter if present
	if (!raw.startsWith("---")) return raw;
	const end = raw.indexOf("---", 3);
	return end === -1 ? raw : raw.slice(end + 3).trimStart();
}

export interface PromptContext {
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	title: string;
	body: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
	labels: string[];
	extraInstructions: string;
	/** When set, replaces the generic "Changed file diffs:" label with a
	 * scope-aware header — used on INCREMENTAL passes to tell agents they are
	 * seeing only a subset of the PR's files. */
	diffScope?: string;
	files: Array<{
		filename: string;
		status: string;
		patch?: string;
	}>;
	priorBotReviews?: string[];
	priorOwnReview?: string | null;
	/** Every finding this reviewer already filed on this PR, with its current
	 * status. The prior review *body* alone is a synthesised summary and does not
	 * list the inline comments, so agents could not see what they had already
	 * said and refiled it round after round. */
	priorOwnFindings?: Array<{
		path: string | null;
		line: number | null;
		title: string;
		severity: string;
		status: string;
	}>;
}

function trimPatch(patch: string, maxChars = 24000): string {
	if (patch.length <= maxChars) {
		return patch;
	}

	return `${patch.slice(0, maxChars)}\n\n[patch truncated]`;
}

function serializeFiles(files: PromptContext["files"]): string {
	return files
		.map((file) => {
			const header = `FILE: ${file.filename}\nSTATUS: ${file.status}`;
			const patch = file.patch
				? `PATCH:\n${trimPatch(file.patch)}`
				: "PATCH: [not available]";
			return `${header}\n${patch}`;
		})
		.join("\n\n---\n\n");
}

export function buildUserMessage(context: PromptContext): string {
	const commandInstructionsSection = context.extraInstructions
		? ["", "Command-specific instructions:", context.extraInstructions]
		: [];

	const priorReviewsSection = context.priorBotReviews?.length
		? [
				"",
				"Prior reviews by other AI reviewers on this commit — do not re-report any finding already mentioned below:",
				"",
				context.priorBotReviews.join("\n\n---\n\n"),
			]
		: [];

	const priorOwnReviewSection = context.priorOwnReview
		? [
				"",
				"You (this same reviewer) previously raised the findings below. Do NOT re-report a finding if the current diff or a maintainer reply already addresses or justifies it; only escalate if it is still genuinely unresolved in the code under review:",
				"",
				context.priorOwnReview,
			]
		: [];

	const priorOwnFindingsSection = context.priorOwnFindings?.length
		? [
				"",
				"Every finding you have already filed on this pull request is listed below, with its status. Treat this as your own memory of this review:",
				"",
				...context.priorOwnFindings.map(
					(f) =>
						`- [${f.status}] ${f.severity} — ${f.path ?? "general"}${
							f.line === null ? "" : `:${f.line}`
						} — ${f.title}`,
				),
				"",
				"Do not file any of these again. A finding marked resolved was fixed; re-raising it is wrong. A finding still open is already on the record; restating it in different words adds nothing and buries the new material. Report only what is genuinely new since these were written.",
			]
		: [];

	return [
		"You are reviewing a GitHub pull request.",
		"",
		"Repo context:",
		`- Repository: ${context.owner}/${context.repo}`,
		`- Pull request: #${context.pullNumber}`,
		`- Head SHA: ${context.headSha}`,
		`- Title: ${context.title}`,
		`- Body: ${context.body ?? "[no description]"}`,
		`- Labels: ${context.labels.length > 0 ? context.labels.join(", ") : "none"}`,
		`- Changed files: ${context.changedFiles}`,
		`- Added lines: ${context.additions}`,
		`- Deleted lines: ${context.deletions}`,
		...commandInstructionsSection,
		...priorReviewsSection,
		...priorOwnReviewSection,
		...priorOwnFindingsSection,
		"",
		context.diffScope
			? `Changed file diffs (${context.diffScope}):`
			: "Changed file diffs:",
		serializeFiles(context.files),
	].join("\n");
}

export interface AuditContext {
	owner: string;
	repo: string;
	ref: string;
	extraInstructions: string;
	files: Array<{ path: string; content: string }>;
}

export function buildAuditUserMessage(context: AuditContext): string {
	const instructionsSection = context.extraInstructions
		? ["", "Additional instructions:", context.extraInstructions]
		: [];

	const serialized = context.files
		.map((f) => {
			// Audited files are whole-file content (size-bounded by batching in
			// runAuditPass), not diffs — do not run them through trimPatch.
			return `FILE: ${f.path}\nCONTENT:\n${f.content}`;
		})
		.join("\n\n---\n\n");

	return [
		"You are performing a full code audit of a repository.",
		"",
		"Repo context:",
		`- Repository: ${context.owner}/${context.repo}`,
		`- Ref: ${context.ref}`,
		`- Files reviewed: ${context.files.length}`,
		...instructionsSection,
		"",
		"Repository files:",
		serialized,
	].join("\n");
}

export interface AgentPromptOptions {
	/** Require every finding to name a defect and rest on the visible diff. */
	strictEvidenceRules?: boolean;
}

export function buildAgentSystemPrompt(
	skillPath: string,
	customPrompt: string,
	options: AgentPromptOptions = {},
): string {
	const skill = loadSkill(skillPath);

	// Written against measured failure modes, not general advice. Each rule below
	// corresponds to a category that showed up repeatedly across #43 and #45 and
	// cost a maintainer a reaction, a reply and a resolve to dispose of.
	const strictRules = options.strictEvidenceRules
		? [
				"",
				"## What Counts As A Finding",
				"- Every finding must name a defect: something that is wrong, will break, or will mislead a maintainer. If your body says the code is correct, well designed, or that no action is needed, do not file it. There is no such thing as a finding with nothing to fix.",
				"- Do not file a finding that asks the reader to verify, confirm, or double-check something. If you cannot tell whether a problem exists, you have not found one. Either establish it from the diff or say nothing.",
				'- Do not speculate about code you cannot see. Schemas, exports, call sites and configuration live in this repository; if your claim depends on one of them and it is not in the diff, you do not know it is wrong. "X may not exist", "ensure Y is updated" and "verify Z is indexed" are not findings.',
				"- A deleted line in a diff is not a removal until you have checked the additions. Code frequently moves. Before reporting that something was deleted, weakened or lost, look for it elsewhere in the same diff.",
				"- Report each distinct claim exactly once, at the single best location. If the same problem appears on several adjacent lines, that is one finding about one problem, not one per line. Restating a claim in different words is a duplicate.",
				"- Do not re-report a finding that already appears in the prior-findings list in the user message, whatever its status.",
				"",
				"## Severity",
				"- `high` means demonstrated data loss, a security impact, or a crash or incorrect result that you can trace in the diff. Name the input or state that triggers it. If you cannot, it is not `high`.",
				"- `medium` means a real defect with a bounded consequence, established from the diff.",
				"- `low` means a genuine but minor issue: a nit, a wording problem, an optional improvement.",
				"- Reserve severity for the defect's impact, not your confidence or the effort to fix. A correct observation with no consequence does not get a severity — it does not get filed.",
			]
		: [];

	return [
		"You are a senior code reviewer. Apply the following review framework to this pull request.",
		"",
		skill,
		"",
		"## Custom Instructions",
		customPrompt,
		"",
		"## Output Rules",
		"- Report only material issues or meaningful risk (≥80% confidence).",
		"- If there are no material issues, use event COMMENT and return empty arrays.",
		"- Do not invent files or line numbers.",
		"- Keep the summary concise.",
		"- Prefer `inline_comments` over `general_findings` whenever the finding targets a specific changed line. Use `general_findings` only for holistic observations that have no single code location (e.g. missing test coverage across the whole PR).",
		"- Only use inline comments for lines that appear in the provided diff. The line number must be a RIGHT-SIDE (new file) line: count `+` and ` ` (context) lines after the `@@` hunk header — never `-` (deleted) lines.",
		"- Use `start_line` for multi-line ranges only, and only when `start_line` is less than `line`. Set `start_line` to `null` for single-line comments.",
		"- Put unanchored concerns into `general_findings`, not `inline_comments`.",
		"- Set `severity` on every inline comment: `high` for correctness/security/blocking bugs, `medium` for significant concerns, `low` for nits, style, or optional improvements. Keep the title a plain description — do not prefix it with the severity.",
		"- When you can supply an exact code fix, set `suggestion` to the complete replacement text for the referenced line(s), matching the original indentation exactly. Set `suggestion` to null when the fix is not a clean line-for-line replacement.",
		"",
		"## Epistemic Guardrails",
		"- You see only the diff and PR metadata — NOT the full repository, its dependencies, or `node_modules`.",
		"- Do not claim a library/framework/SDK API, method, or option does not exist, is invalid, or will fail at runtime based on your own knowledge — your training data may be outdated and you cannot see the installed version. Raise a suspected API misuse as a low-severity question, never a blocking finding.",
		"- Do not assert that a symbol, import, function, or file exists or does not exist unless the diff shows it. If a finding depends on code not present in the diff, lower its severity or omit it.",
		"- A TypeScript `import type { … }` is erased at compile time and has no runtime effect — never flag a type-only import as a runtime or bundle concern.",
		// Superseded by the Severity block below when strict rules are on, so the
		// prompt never carries two definitions of `high` for the model to
		// reconcile. Kept verbatim otherwise.
		...(options.strictEvidenceRules
			? []
			: [
					"- `high` severity requires evidence visible in the diff itself; knowledge-based or speculative concerns are at most `low`, phrased as a question.",
				]),
		...strictRules,
	].join("\n");
}
