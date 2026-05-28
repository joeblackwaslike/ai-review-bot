# How it works

## Overview

ai-review-bot is a GitHub App that posts structured code reviews in response to slash commands on pull requests. Unlike single-prompt review bots, it runs five specialized agents in parallel and merges their findings before posting.

## Request flow

```
Comment /ai-review on a PR
  ↓
GitHub fires issue_comment.created webhook
  ↓
/api/github/webhook verifies HMAC-SHA256 signature
  ↓
parseReviewCommand() extracts --force and extra instructions
  ↓
maybeSubmitReview() checks: draft PR? already reviewed this SHA?
  ↓
buildReview() — the two-layer engine
  ↓
POST review to GitHub Reviews API (with fallback retry)
```

## The two-layer engine

### Layer 1 — Five agents in parallel

`buildReview()` fires five Anthropic API calls simultaneously via `Promise.allSettled()`. Each call has:

- A **focused system prompt** containing one review framework (`buildAgentSystemPrompt(skillPath, customPrompt)`)
- The **same user message** containing PR metadata and the serialized diff (`buildUserMessage()`)
- Prompt caching (`cache_control: ephemeral`) on the system prompt so repeated reviews of the same repo share a cached prefix
- `tool_choice: { type: "tool", name: "submit_review" }` — the model is forced to return structured JSON

`Promise.allSettled` (not `Promise.all`) means one flaky API call or timeout won't abort the whole review. The merge layer works with whatever agents succeeded.

#### The five agents

| Agent | Framework | What it finds |
| --- | --- | --- |
| **code-reviewer** | `pr-review-toolkit:code-reviewer` | Bugs, null/undefined handling, race conditions, project standard violations. ≥80% confidence threshold — only reports what it's sure about. |
| **silent-failure-hunter** | `pr-review-toolkit:silent-failure-hunter` | Empty catch blocks, swallowed exceptions, silent fallbacks that hide errors. False negatives here are expensive, so overlap with other agents is acceptable. |
| **pr-test-analyzer** | `pr-review-toolkit:pr-test-analyzer` | New behavior with no corresponding test. Assigns a criticality score (1–10) — flags critical paths (8–10) with no test coverage. |
| **security-sast** | `security-scanning:security-sast` | Injection vectors, path traversal, hardcoded secrets, XSS, insecure deserialization. Pattern-based — catches known vulnerability shapes the LLM might miss. |
| **code-review-and-quality** | `addyosmani:code-review-and-quality` | Five-axis checklist: correctness, readability, architecture, security, performance. Uses Critical/Nit/Optional/FYI severity labels. |

Each skill framework is a vendored Markdown file in `skills/`. The frontmatter is stripped at load time; only the framework content is injected into the agent's system prompt.

### Layer 2 — Merge

After all agents settle, `mergeReviews()` combines their outputs:

**Inline comments** — deduplicated by `path:line` key. When two agents flag the same location:
- If one agent's `event` is `REQUEST_CHANGES` and the other is `COMMENT`, the `REQUEST_CHANGES` agent's comment wins (more conservative finding)
- Otherwise, first seen wins

**General findings** — deduplicated by title (case-insensitive). Each agent focuses on a different domain, so general-finding overlap is rare.

**Verdict** — `REQUEST_CHANGES` if any agent returned it, `COMMENT` otherwise. The bot never posts `APPROVE` — it can only signal that it found (or didn't find) issues in the diff it was given.

**Summary** — non-empty, non-trivial summaries from each agent are joined. "No issues found" summaries are filtered out.

## Diff anchor validation

Before submission, every inline comment is validated against the set of valid right-side line numbers in the diff (`collectRightSideLines()`). This function parses the unified diff hunk headers (`@@ -a,b +c,d @@`) and tracks which lines on the right side (added lines and context lines) are referenceable.

Comments that reference:
- A path not in the diff
- A line number not in the right-side valid set
- A `start_line` ≥ `line` (backwards range)
- `start_line: 0` (a known model output bug — model returns 0 instead of null)

...are dropped silently. The review posts with the remaining valid comments.

Up to 10 inline comments are submitted per review. This prevents very noisy reviews on large diffs.

## Fallback retry

If the GitHub Reviews API rejects the POST (status 422 — e.g. a bad anchor slipped through validation), the bot retries the same review body with an empty `comments` array. This ensures the review summary and general findings always reach the PR author even if every inline comment is rejected.

If the retry also fails (or if the original failed with no inline comments), the error is thrown and logged to Vercel.

## Idempotency

Each review body includes a hidden marker:

```
Reviewed commit: `<first 12 chars of head SHA>`
```

Before running agents, the bot fetches existing reviews on the PR and checks whether any body contains this marker. If found, it returns `null` and skips submission. Pass `--force` to override: `/ai-review --force`.

## Trigger modes

The bot responds to two GitHub events:

- **`issue_comment.created`** — slash command on a PR comment (`/ai-review`)
- **`pull_request.opened` / `pull_request.synchronize`** — automatic review on new PRs and new commits (only if `REVIEW_ENABLED=true`; draft PRs are always skipped)

Only comments from `OWNER`, `MEMBER`, or `COLLABORATOR` author associations trigger a review from the slash command path.
