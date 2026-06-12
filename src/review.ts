import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./anthropic.js";
import { getConfig } from "./config.js";
import { buildAgentSystemPrompt, buildUserMessage } from "./prompt.js";

type OctokitLike = {
	request: <T>(
		route: string,
		params: Record<string, string | number>,
	) => Promise<{ data: T }>;
	paginate: <T>(
		route: string,
		params: Record<string, string | number>,
	) => Promise<T[]>;
};

interface PullFile {
	filename: string;
	status: string;
	patch?: string;
}

interface ReviewContext {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	title: string;
	body: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
	commentPrefix: string;
	extraInstructions: string;
	force: boolean;
}

interface ReviewDecision {
	event: "COMMENT" | "REQUEST_CHANGES";
	body: string;
	comments: ReviewComment[];
}

interface ModelFinding {
	title: string;
	body: string;
}

interface ModelInlineComment {
	title: string;
	body: string;
	path: string;
	line: number;
	start_line: number | null;
}

export interface ModelReview {
	summary: string;
	event: "COMMENT" | "REQUEST_CHANGES";
	general_findings: ModelFinding[];
	inline_comments: ModelInlineComment[];
}

interface PullRequestReview {
	body?: string | null;
}

interface ReviewComment {
	path: string;
	body: string;
	line: number;
	side: "RIGHT";
	start_line?: number;
	start_side?: "RIGHT";
}

// The 5 agent skills run in parallel — one focused API call per framework.
const AGENT_SKILLS = [
	"code-reviewer.md",
	"silent-failure-hunter.md",
	"pr-test-analyzer.md",
	"security-sast.md",
	"code-review-and-quality.md",
] as const;

const SUBMIT_REVIEW_TOOL = {
	name: "submit_review",
	description:
		"Submit the final code review with findings and inline comments.",
	input_schema: {
		type: "object" as const,
		additionalProperties: false,
		required: ["summary", "event", "general_findings", "inline_comments"],
		properties: {
			summary: { type: "string" },
			event: {
				type: "string",
				enum: ["COMMENT", "REQUEST_CHANGES"],
			},
			general_findings: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["title", "body"],
					properties: {
						title: { type: "string" },
						body: { type: "string" },
					},
				},
			},
			inline_comments: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["title", "body", "path", "line", "start_line"],
					properties: {
						title: { type: "string" },
						body: { type: "string" },
						path: { type: "string" },
						line: { type: "integer" },
						start_line: { type: ["integer", "null"] },
					},
				},
			},
		},
	},
} as const;

async function runAgent(
	skillPath: string,
	userMessage: string,
	model: string,
	client: ReturnType<typeof getAnthropicClient>,
	customPrompt: string,
): Promise<ModelReview | null> {
	const system = buildAgentSystemPrompt(skillPath, customPrompt);

	const response = await client.messages.create({
		model,
		max_tokens: 4096,
		system: [
			{ type: "text", text: system, cache_control: { type: "ephemeral" } },
		],
		tool_choice: { type: "tool", name: "submit_review" },
		tools: [SUBMIT_REVIEW_TOOL],
		messages: [{ role: "user", content: userMessage }],
	});

	const toolBlock = response.content.find(
		(b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
	);

	if (!toolBlock) {
		console.error("Agent did not call submit_review tool", { skillPath });
		return null;
	}

	return toolBlock.input as ModelReview;
}

function mergeReviews(agentResults: ModelReview[]): ModelReview {
	// Determine verdict: REQUEST_CHANGES if any agent found blocking issues.
	const event: "COMMENT" | "REQUEST_CHANGES" = agentResults.some(
		(r) => r.event === "REQUEST_CHANGES",
	)
		? "REQUEST_CHANGES"
		: "COMMENT";

	// Combine summaries, skipping empty or "no issues" ones.
	const summaries = agentResults
		.map((r) => r.summary.trim())
		.filter(
			(s) =>
				s.length > 0 &&
				!s.toLowerCase().startsWith("no issues") &&
				!s.toLowerCase().startsWith("no material"),
		);
	const summary = summaries.length > 0 ? summaries.join("\n\n") : "";

	// Deduplicate general findings by title (case-insensitive).
	const seenTitles = new Set<string>();
	const general_findings = agentResults
		.flatMap((r) => r.general_findings)
		.filter((f) => {
			const key = f.title.toLowerCase().trim();
			if (seenTitles.has(key)) return false;
			seenTitles.add(key);
			return true;
		});

	// Deduplicate inline comments by path:line.
	// When two agents flag the same location, prefer the one from a
	// REQUEST_CHANGES agent (more conservative finding wins).
	const commentMap = new Map<
		string,
		{ comment: ModelInlineComment; priority: number }
	>();
	for (const review of agentResults) {
		const priority = review.event === "REQUEST_CHANGES" ? 1 : 0;
		for (const comment of review.inline_comments) {
			const key = `${comment.path}:${comment.line}`;
			const existing = commentMap.get(key);
			if (!existing || priority > existing.priority) {
				commentMap.set(key, { comment, priority });
			}
		}
	}

	return {
		summary,
		event,
		general_findings,
		inline_comments: Array.from(commentMap.values()).map((v) => v.comment),
	};
}

function formatFindings(findings: ModelFinding[]): string {
	if (findings.length === 0) {
		return "";
	}

	return findings
		.map((finding) => {
			return `#### ${finding.title}\n\n${finding.body}`;
		})
		.join("\n\n");
}

export function collectRightSideLines(patch: string): Set<number> {
	const lines = new Set<number>();
	const patchLines = patch.split("\n");
	let nextRightLine = 0;

	for (const line of patchLines) {
		if (line.startsWith("@@")) {
			const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (!match) {
				continue;
			}
			nextRightLine = Number(match[1]);
			continue;
		}

		if (line.startsWith("+")) {
			lines.add(nextRightLine);
			nextRightLine += 1;
			continue;
		}

		if (line.startsWith(" ")) {
			lines.add(nextRightLine);
			nextRightLine += 1;
			continue;
		}

		if (line.startsWith("-")) {
		}
	}

	return lines;
}

function buildCommentBody(comment: ModelInlineComment): string {
	return `**${comment.title}**\n\n${comment.body}`;
}

export function buildReviewComments(
	files: PullFile[],
	inlineComments: ModelInlineComment[],
): ReviewComment[] {
	const validLinesByPath = new Map<string, Set<number>>();

	for (const file of files) {
		if (!file.patch) {
			continue;
		}
		validLinesByPath.set(file.filename, collectRightSideLines(file.patch));
	}

	return inlineComments.flatMap((comment) => {
		const validLines = validLinesByPath.get(comment.path);
		if (!validLines) {
			console.log("inline comment dropped: path not in diff", {
				path: comment.path,
				line: comment.line,
				knownPaths: Array.from(validLinesByPath.keys()),
			});
			return [];
		}

		if (!validLines.has(comment.line)) {
			console.log(
				"inline comment dropped: line not in valid right-side lines",
				{
					path: comment.path,
					line: comment.line,
					validLines: Array.from(validLines).sort((a, b) => a - b),
				},
			);
			return [];
		}

		if (comment.start_line !== null && comment.start_line >= comment.line) {
			console.log(
				"inline comment dropped: start_line >= line (backwards range)",
				{
					path: comment.path,
					line: comment.line,
					start_line: comment.start_line,
				},
			);
			return [];
		}

		const startLine =
			comment.start_line !== null ? comment.start_line : undefined;
		if (startLine !== undefined && !validLines.has(startLine)) {
			console.log(
				"inline comment dropped: start_line not in valid right-side lines",
				{
					path: comment.path,
					line: comment.line,
					start_line: startLine,
				},
			);
			return [];
		}

		return [
			{
				path: comment.path,
				body: buildCommentBody(comment),
				line: comment.line,
				side: "RIGHT" as const,
				...(startLine !== undefined
					? { start_line: startLine, start_side: "RIGHT" as const }
					: {}),
			},
		];
	});
}

export async function buildReview(
	context: ReviewContext,
): Promise<ReviewDecision | null> {
	const reviewMarker = `Reviewed commit: \`${context.headSha.slice(0, 12)}\``;
	if (!context.force) {
		const existing = await context.octokit.request<PullRequestReview[]>(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{
				owner: context.owner,
				repo: context.repo,
				pull_number: context.pullNumber,
			},
		);

		const alreadyReviewed = existing.data.some((review) =>
			(review.body ?? "").includes(reviewMarker),
		);

		if (alreadyReviewed) {
			return null;
		}
	}

	const files = await context.octokit.paginate<PullFile>(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
		{
			owner: context.owner,
			repo: context.repo,
			pull_number: context.pullNumber,
		},
	);

	const config = getConfig();
	const client = getAnthropicClient();
	const customPrompt =
		process.env.CUSTOM_REVIEW_PROMPT ??
		"Focus on correctness, security, regressions, and missing tests.";

	const userMessage = buildUserMessage({
		owner: context.owner,
		repo: context.repo,
		pullNumber: context.pullNumber,
		headSha: context.headSha,
		title: context.title,
		body: context.body,
		additions: context.additions,
		deletions: context.deletions,
		changedFiles: context.changedFiles,
		extraInstructions: context.extraInstructions,
		files,
	});

	// Agent layer: run all 5 skill frameworks in parallel.
	const agentPromises = AGENT_SKILLS.map((skillPath) =>
		runAgent(
			skillPath,
			userMessage,
			config.anthropicModel,
			client,
			customPrompt,
		),
	);

	const settled = await Promise.allSettled(agentPromises);

	const agentResults: ModelReview[] = [];
	for (const [i, result] of settled.entries()) {
		if (result.status === "rejected") {
			console.error("Agent failed", {
				skillPath: AGENT_SKILLS[i],
				error: result.reason,
			});
		} else if (result.value !== null) {
			agentResults.push(result.value);
		}
	}

	if (agentResults.length === 0) {
		throw new Error("All review agents failed — no results to merge");
	}

	console.log("agent results collected", {
		total: AGENT_SKILLS.length,
		succeeded: agentResults.length,
		failed: AGENT_SKILLS.length - agentResults.length,
	});

	// Merge layer: deduplicate findings, resolve conflicts, emit verdict.
	const modelReview = mergeReviews(agentResults);

	console.log("merged review", {
		event: modelReview.event,
		generalFindings: modelReview.general_findings.length,
		inlineComments: modelReview.inline_comments.length,
		inlineCommentPaths: modelReview.inline_comments.map(
			(c) => `${c.path}:${c.line}`,
		),
	});

	const reviewComments = buildReviewComments(
		files,
		modelReview.inline_comments,
	).slice(0, 10);

	console.log("inline comments after validation", {
		submitted: reviewComments.length,
		dropped: modelReview.inline_comments.length - reviewComments.length,
	});

	const findingsBlock = formatFindings(modelReview.general_findings);
	const inlineSummary =
		reviewComments.length > 0
			? `Inline comments: ${reviewComments.length}`
			: "Inline comments: none";
	const body = [
		`### ${context.commentPrefix}`,
		"",
		modelReview.summary,
		"",
		inlineSummary,
		findingsBlock ? `\n${findingsBlock}\n` : "",
		reviewMarker,
	]
		.filter((part) => part.length > 0)
		.join("\n");

	return {
		event: modelReview.event,
		body,
		comments: reviewComments,
	};
}
