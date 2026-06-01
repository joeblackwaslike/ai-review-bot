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
	extraInstructions: string;
	files: Array<{
		filename: string;
		status: string;
		patch?: string;
	}>;
	priorBotReviews?: string[];
}

function trimPatch(patch: string, maxChars = 8000): string {
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

	const priorReviewsSection =
		context.priorBotReviews?.length
			? [
					"",
					"Prior reviews by other AI reviewers on this commit — do not re-report any finding already mentioned below:",
					"",
					context.priorBotReviews.join("\n\n---\n\n"),
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
		`- Changed files: ${context.changedFiles}`,
		`- Added lines: ${context.additions}`,
		`- Deleted lines: ${context.deletions}`,
		...commandInstructionsSection,
		...priorReviewsSection,
		"",
		"Changed file diffs:",
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
			const content = trimPatch(f.content);
			return `FILE: ${f.path}\nCONTENT:\n${content}`;
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

export function buildAgentSystemPrompt(
	skillPath: string,
	customPrompt: string,
): string {
	const skill = loadSkill(skillPath);

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
		"- Only use inline comments for lines that appear in the provided diff.",
		"- Use `start_line` for multi-line ranges only, and only when `start_line` is less than `line`. Set `start_line` to `null` for single-line comments.",
		"- Put unanchored concerns into `general_findings`, not `inline_comments`.",
		"- Apply the severity label (Critical / Nit / Optional / FYI) in every inline comment title.",
	].join("\n");
}
