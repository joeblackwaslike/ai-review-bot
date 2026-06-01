# How it works

## Overview

ai-review-bot deploys two GitHub Apps from a single Vercel deployment — a **Claude bot** (Anthropic) and a **Codex bot** (OpenAI). Each has its own icon and posts reviews independently. Install both on a repo and you get two expert opinions side by side on every `/ai-review` comment.

Both bots use the same five-agent review engine and the same merge logic. The only difference is which AI provider runs the agents and how model complexity is expressed (extended thinking vs. reasoning effort).

## Request flow

```text
Comment /ai-review on a PR
  ↓
GitHub fires issue_comment.created webhook to both apps simultaneously
  ↓
Claude bot: /api/github/webhook        Codex bot: /api/github/webhook-openai
  ↓                                      ↓
verifies HMAC-SHA256 signature         verifies HMAC-SHA256 signature
  ↓                                      ↓
parseReviewCommand()                   parseReviewCommand()
  ↓                                      ↓
maybeSubmitReview()                    maybeSubmitReview()
  ↓                                      ↓
buildReview(provider="anthropic")      buildReview(provider="openai")
  ↓                                      ↓
POST review to GitHub Reviews API      POST review to GitHub Reviews API
```

Both bots run independently and concurrently. The reviews appear in the PR timeline as separate comments, each attributed to its GitHub App identity.

## Provider routing

Before firing agents, the router (`src/router.ts`) classifies the PR into a tier based on diff size, file paths, and PR labels, then selects the model:

| Tier | Trigger | Claude | Codex |
| --- | --- | --- | --- |
| `trivial` | Doc-only files, <20 lines | `claude-haiku-4-5` | `gpt-5` |
| `normal` | Standard PR | `claude-sonnet-4-6` | `gpt-5` |
| `complex` | >500 lines or sensitive paths (auth, crypto, db…) | `claude-sonnet-4-6` + 8K thinking | `o4-mini` reasoning medium |
| `deep` | `deep-review` label | `claude-opus-4-7` + 16K thinking | `o3` reasoning high |

Claude uses `thinkingBudget` (extended thinking tokens) for complex and deep tiers. Codex uses `reasoningEffort` (`"medium"` / `"high"`) for the equivalent tiers.

## The two-layer engine

### Layer 1 — Five agents in parallel

`buildReview()` fires five API calls simultaneously via `Promise.allSettled()`. Each call has:

- A **focused system prompt** containing one review framework (`buildAgentSystemPrompt(skillPath, customPrompt)`)
- The **same user message** containing PR metadata and the serialized diff (`buildUserMessage()`)
- Prompt caching (`cache_control: ephemeral`) on the system prompt so repeated reviews of the same repo share a cached prefix
- `tool_choice: { type: "tool", name: "submit_review" }` — the model is forced to return structured JSON via tool use

`Promise.allSettled` (not `Promise.all`) means one flaky API call or timeout won't abort the whole review. The merge layer works with whatever agents succeeded.

#### The five agents

| Agent | Framework | What it finds |
| --- | --- | --- |
| **code-reviewer** | `pr-review-toolkit:code-reviewer` | Bugs, null/undefined handling, race conditions, project standard violations. ≥80% confidence threshold — only reports what it's sure about. |
| **silent-failure-hunter** | `pr-review-toolkit:silent-failure-hunter` | Empty catch blocks, swallowed exceptions, silent fallbacks that hide errors. |
| **pr-test-analyzer** | `pr-review-toolkit:pr-test-analyzer` | New behavior with no corresponding test. Assigns a criticality score (1–10) — flags critical paths (8–10) with no test coverage. |
| **security-sast** | `security-scanning:security-sast` | Injection vectors, path traversal, hardcoded secrets, XSS, insecure deserialization. |
| **code-review-and-quality** | `addyosmani:code-review-and-quality` | Five-axis checklist: correctness, readability, architecture, security, performance. |

Each skill framework is a vendored Markdown file in `skills/`. The frontmatter is stripped at load time; only the framework content is injected into the agent's system prompt.

### Layer 2 — Merge

After all agents settle, `mergeReviews()` combines their outputs:

**Inline comments** — deduplicated by `path:line` key. When two agents flag the same location, the `REQUEST_CHANGES` agent's comment wins (more conservative finding).

**General findings** — deduplicated by title (case-insensitive).

**Verdict** — `REQUEST_CHANGES` if any agent returned it, `COMMENT` otherwise. The bot never posts `APPROVE`.

**Summary** — non-empty, non-trivial summaries from each agent are joined. "No issues found" summaries are filtered out.

## Diff anchor validation

Before submission, every inline comment is validated against the set of valid right-side line numbers in the diff (`collectRightSideLines()`). Comments referencing a path not in the diff, a line not in the valid set, a backwards range (`start_line >= line`), or `start_line: 0` are dropped silently.

Up to 10 inline comments are submitted per review.

## Fallback retry

If the GitHub Reviews API rejects the POST (status 422), the bot retries with an empty `comments` array. This ensures the review summary and general findings always reach the PR author even if every inline comment is rejected.

## Idempotency

Each review body includes a hidden marker:

```text
Reviewed commit: `<first 12 chars of head SHA>`
```

Before running agents, the bot checks existing reviews for this marker. If found, it skips submission. Pass `--force` to override.

## Trigger modes

### Automatic (default)

Once both apps are installed on a repo, reviews happen automatically — no slash command needed. Both bots post a review on every pull request the moment it is opened or a new commit is pushed to it. This is the normal operating mode.

- **`pull_request.opened`** — fires when a PR is created; both bots review it automatically after a short delay (`REVIEW_DELAY_SECONDS`, default 7.5 min) to give CI a chance to run first
- **`pull_request.synchronize`** — fires when a new commit is pushed to an open PR; both bots re-review the updated diff

Draft PRs are always skipped. Reviews are idempotent per commit SHA — pushing the same commit twice won't produce duplicate reviews.

To disable automatic reviews while keeping slash-command reviews active, set `REVIEW_ENABLED=false`.

### Manual (slash command)

The slash command is for cases outside the automatic flow: PRs that were already open when the apps were installed, re-reviewing after the auto-review failed, or requesting a fresh review with extra instructions.

```text
/ai-review                               # re-review current commit
/ai-review focus on the auth layer       # with extra instructions
/ai-review --force                       # re-review even if this SHA was already reviewed
/ai-review --force check for regressions # force + extra instructions
```

Only comments from `OWNER`, `MEMBER`, or `COLLABORATOR` author associations trigger a slash-command review.
