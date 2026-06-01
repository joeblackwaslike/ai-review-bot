import { generateObject } from "ai";
import { z } from "zod";
import { computeCost, createAIModel } from "./models.js";
import { buildAgentSystemPrompt, buildUserMessage } from "./prompt.js";
import type { ModelSelection } from "./router.js";
import { routeModel } from "./router.js";

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
	labels: string[];
	commentPrefix: string;
	extraInstructions: string;
	force: boolean;
	provider: "anthropic" | "openai";
}

interface ReviewDecision {
	event: "COMMENT" | "REQUEST_CHANGES";
	body: string;
	comments: ReviewComment[];
}

interface ReviewComment {
	path: string;
	body: string;
	line: number;
	side: "RIGHT";
	start_line?: number;
	start_side?: "RIGHT";
}

interface PullRequestReview {
	body?: string | null;
}

interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
}

const ModelReviewSchema = z.object({
	summary: z.string(),
	event: z.enum(["COMMENT", "REQUEST_CHANGES"]),
	general_findings: z.array(
		z.object({
			title: z.string(),
			body: z.string(),
			severity: z.enum(["high", "medium", "low"]),
		}),
	),
	inline_comments: z.array(
		z.object({
			title: z.string(),
			body: z.string(),
			path: z.string(),
			line: z.number().int(),
			start_line: z.number().int().nullable(),
		}),
	),
});

export type ModelReview = z.infer<typeof ModelReviewSchema>;

type ModelFinding = ModelReview["general_findings"][number];
type ModelInlineComment = ModelReview["inline_comments"][number];

const SEVERITY_EMOJI: Record<"high" | "medium" | "low", string> = {
	high: "🔴",
	medium: "🟡",
	low: "🟢",
};

// The 5 agent skills run in parallel — one focused API call per framework.
export const AGENT_SKILLS = [
	"code-reviewer.md",
	"silent-failure-hunter.md",
	"pr-test-analyzer.md",
	"security-sast.md",
	"code-review-and-quality.md",
] as const;

export async function runAgent(
	skillPath: string,
	userMessage: string,
	selection: ModelSelection,
	customPrompt: string,
): Promise<{ review: ModelReview; usage: TokenUsage } | null> {
	const system = buildAgentSystemPrompt(skillPath, customPrompt);

	try {
		const { object, usage } = await generateObject({
			model: createAIModel(selection),
			schema: ModelReviewSchema,
			maxOutputTokens: 4096,
			system,
			messages: [{ role: "user", content: userMessage }],
		});

		return {
			review: object,
			usage: {
				promptTokens: usage.inputTokens ?? 0,
				completionTokens: usage.outputTokens ?? 0,
			},
		};
	} catch (err) {
		console.error("Agent threw during generateObject", { skillPath, err });
		return null;
	}
}

export function mergeReviews(agentResults: ModelReview[]): ModelReview {
	const event: "COMMENT" | "REQUEST_CHANGES" = agentResults.some(
		(r) => r.event === "REQUEST_CHANGES",
	)
		? "REQUEST_CHANGES"
		: "COMMENT";

	const summaries = agentResults
		.map((r) => r.summary.trim())
		.filter(
			(s) =>
				s.length > 0 &&
				!s.toLowerCase().startsWith("no issues") &&
				!s.toLowerCase().startsWith("no material"),
		);
	const summary = summaries.length > 0 ? summaries.join("\n\n") : "";

	const seenTitles = new Set<string>();
	const general_findings = agentResults
		.flatMap((r) => r.general_findings)
		.filter((f) => {
			const key = f.title.toLowerCase().trim();
			if (seenTitles.has(key)) return false;
			seenTitles.add(key);
			return true;
		});

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

	const rows = findings
		.map((f) => `| ${SEVERITY_EMOJI[f.severity]} | **${f.title}** |`)
		.join("\n");

	return `| Sev | Finding |\n|---|---|\n${rows}`;
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

	// Always fetch existing reviews — used for both idempotency check and
	// cross-bot dedup (collecting what the other bot already reported).
	const existingReviews = (
		await context.octokit.request<PullRequestReview[]>(
			"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			{
				owner: context.owner,
				repo: context.repo,
				pull_number: context.pullNumber,
			},
		)
	).data;

	if (!context.force) {
		const alreadyReviewed = existingReviews.some((review) => {
			const body = review.body ?? "";
			return (
				body.includes(reviewMarker) &&
				body.includes(`### ${context.commentPrefix}`)
			);
		});

		if (alreadyReviewed) {
			return null;
		}
	}

	// Collect reviews from OTHER bots on the same commit. These are passed into
	// the prompt so agents avoid re-reporting findings already raised.
	const priorBotReviews = existingReviews
		.filter((review) => {
			const body = review.body ?? "";
			return (
				body.includes(reviewMarker) &&
				!body.includes(`### ${context.commentPrefix}`)
			);
		})
		.map((review) => review.body as string);

	const files = await context.octokit.paginate<PullFile>(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
		{
			owner: context.owner,
			repo: context.repo,
			pull_number: context.pullNumber,
		},
	);

	const customPrompt =
		process.env.CUSTOM_REVIEW_PROMPT ??
		"Focus on correctness, security, regressions, and missing tests.";

	const filePaths = files.map((f) => f.filename);
	const selection = routeModel(
		{
			additions: context.additions,
			deletions: context.deletions,
			filePaths,
			labels: context.labels,
		},
		context.provider,
	);

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
		priorBotReviews,
	});

	const agentPromises = AGENT_SKILLS.map((skillPath) =>
		runAgent(skillPath, userMessage, selection, customPrompt),
	);

	const settled = await Promise.allSettled(agentPromises);

	const agentResults: ModelReview[] = [];
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;

	for (const [i, result] of settled.entries()) {
		if (result.status === "rejected") {
			console.error("Agent failed", {
				skillPath: AGENT_SKILLS[i],
				error: result.reason,
			});
		} else if (result.value !== null) {
			agentResults.push(result.value.review);
			totalPromptTokens += result.value.usage.promptTokens;
			totalCompletionTokens += result.value.usage.completionTokens;
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

	const modelReview = mergeReviews(agentResults);

	console.log("merged review", {
		event: modelReview.event,
		generalFindings: modelReview.general_findings.length,
		inlineComments: modelReview.inline_comments.length,
		inlineCommentPaths: modelReview.inline_comments.map(
			(c) => `${c.path}:${c.line}`,
		),
	});

	const reviewComments = buildReviewComments(files, modelReview.inline_comments);

	console.log("inline comments after validation", {
		submitted: reviewComments.length,
		dropped: modelReview.inline_comments.length - reviewComments.length,
	});

	const cost = computeCost(
		{
			promptTokens: totalPromptTokens,
			completionTokens: totalCompletionTokens,
		},
		selection.model,
	);

	const findingsBlock = formatFindings(modelReview.general_findings);
	const inlineSummary =
		reviewComments.length > 0
			? `Inline comments: ${reviewComments.length}`
			: "Inline comments: none";
	const costFooter = `---\n*Model: ${selection.model} · ${AGENT_SKILLS.length} agents · $${cost.toFixed(6)} · [ai-review-bot](https://github.com/joeblackwaslike/ai-review-bot)*`;

	const body = [
		`### ${context.commentPrefix}`,
		"",
		modelReview.summary,
		"",
		inlineSummary,
		findingsBlock ? `\n${findingsBlock}\n` : "",
		reviewMarker,
		"",
		costFooter,
	]
		.filter((part) => part.length > 0)
		.join("\n");

	return {
		event: modelReview.event,
		body,
		comments: reviewComments,
	};
}
