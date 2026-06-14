/**
 * Reusable test fixtures and data factories for ai-review-bot.
 *
 * No vitest import — these are plain data builders. Use vi.fn() in your test file
 * and populate the mocks using these helpers.
 *
 * Ported from codex-review-bot/src/testing.ts — ModelReview shape is identical.
 */

// ---------------------------------------------------------------------------
// Patch fixtures
// ---------------------------------------------------------------------------

/** A minimal unified diff hunk covering right-side lines 1, 2, 3. */
export const SIMPLE_PATCH = [
	"@@ -1,2 +1,3 @@",
	" line1",
	"+line2",
	" line3",
].join("\n");

/** A two-hunk patch covering lines 1–3 and 10–12 on the right side. */
export const TWO_HUNK_PATCH = [
	"@@ -1,2 +1,3 @@",
	" line1",
	"+line2",
	" line3",
	"@@ -8,2 +9,4 @@",
	" context",
	"+added-a",
	"+added-b",
	" context2",
].join("\n");

// ---------------------------------------------------------------------------
// Pull file factory
// ---------------------------------------------------------------------------

export interface PullFileFixture {
	filename: string;
	status: string;
	patch?: string;
}

export function buildPullFile(
	filename: string,
	patch: string,
	status = "modified",
): PullFileFixture {
	return { filename, status, patch };
}

/** A file with no patch (e.g. binary or rename-only). */
export function buildPatchlessPullFile(
	filename: string,
	status = "renamed",
): PullFileFixture {
	return { filename, status };
}

// ---------------------------------------------------------------------------
// Inline comment factory
// ---------------------------------------------------------------------------

export interface InlineCommentFixture {
	title: string;
	body: string;
	path: string;
	line: number;
	start_line: number | null;
	suggestion: string | null;
	severity: "high" | "medium" | "low";
}

export function buildInlineComment(
	overrides?: Partial<InlineCommentFixture>,
): InlineCommentFixture {
	return {
		title: "Test finding",
		body: "Test body.",
		path: "src/file.ts",
		line: 2,
		start_line: null,
		suggestion: null,
		severity: "medium",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Model review factory
// ---------------------------------------------------------------------------

export interface ModelReviewFixture {
	event: "COMMENT" | "REQUEST_CHANGES";
	general_findings: Array<{
		title: string;
		body: string;
		severity: "high" | "medium" | "low";
	}>;
	inline_comments: InlineCommentFixture[];
}

export function buildModelReview(
	overrides?: Partial<ModelReviewFixture>,
): ModelReviewFixture {
	return {
		event: "COMMENT",
		general_findings: [],
		inline_comments: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Webhook payload factories
// ---------------------------------------------------------------------------

export interface IssueCommentPayloadOptions {
	action: string;
	body: string;
	authorAssociation: string;
	isPR: boolean;
	pullNumber: number;
	owner: string;
	repo: string;
	installationId: number;
}

export function buildIssueCommentPayload(
	overrides?: Partial<IssueCommentPayloadOptions>,
) {
	const opts: IssueCommentPayloadOptions = {
		action: "created",
		body: "/ai-review",
		authorAssociation: "OWNER",
		isPR: true,
		pullNumber: 1,
		owner: "owner",
		repo: "repo",
		installationId: 123,
		...overrides,
	};

	return {
		action: opts.action,
		installation: { id: opts.installationId },
		issue: {
			number: opts.pullNumber,
			pull_request: opts.isPR
				? { url: "https://api.github.com/repos/owner/repo/pulls/1" }
				: undefined,
		},
		comment: {
			body: opts.body,
			author_association: opts.authorAssociation,
		},
		repository: {
			name: opts.repo,
			owner: { login: opts.owner },
		},
	};
}

export interface PullRequestPayloadOptions {
	action: string;
	pullNumber: number;
	owner: string;
	repo: string;
	installationId: number;
	draft: boolean;
	headSha: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	title: string;
	body: string | null;
}

export function buildPullRequestPayload(
	overrides?: Partial<PullRequestPayloadOptions>,
) {
	const opts: PullRequestPayloadOptions = {
		action: "opened",
		pullNumber: 1,
		owner: "owner",
		repo: "repo",
		installationId: 123,
		draft: false,
		headSha: "abc1234567890def",
		additions: 10,
		deletions: 5,
		changedFiles: 2,
		title: "Test PR",
		body: "Test description",
		...overrides,
	};

	return {
		action: opts.action,
		installation: { id: opts.installationId },
		number: opts.pullNumber,
		pull_request: {
			draft: opts.draft,
			head: { sha: opts.headSha },
			additions: opts.additions,
			deletions: opts.deletions,
			changed_files: opts.changedFiles,
			title: opts.title,
			body: opts.body,
		},
		repository: {
			name: opts.repo,
			owner: { login: opts.owner },
		},
	};
}

// ---------------------------------------------------------------------------
// Octokit mock configuration helpers
// (call vi.fn() in your test file and use these to configure return values)
// ---------------------------------------------------------------------------

/** Returns the shape expected from GET .../pulls/{n}/reviews */
export function reviewsResponse(reviews: Array<{ body: string }> = []) {
	return { data: reviews };
}

/** A review body marker for a given head SHA (first 12 chars). */
export function reviewedCommitMarker(headSha: string) {
	return `Reviewed commit: \`${headSha.slice(0, 12)}\``;
}

// ---------------------------------------------------------------------------
// Vercel AI SDK response mock helpers
// ---------------------------------------------------------------------------

/** Wraps a ModelReviewFixture in the generateObject() return shape. */
export function buildGenerateObjectResponse(review: ModelReviewFixture) {
	return {
		object: review,
		usage: { promptTokens: 100, completionTokens: 50 },
	};
}
