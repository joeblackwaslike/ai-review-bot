# How it works

## Overview

ai-review-bot deploys two GitHub Apps from a single Vercel deployment — a **Claude bot** (Anthropic) and a **Codex bot** (OpenAI). Each has its own icon and posts reviews independently. Install both on a repo and you get two expert opinions side by side on every `/ai-review` comment.

Both bots use the same review engine and the same merge logic. The only difference is which AI provider runs the agents and how model complexity is expressed (extended thinking vs. reasoning effort).

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

### Layer 1 — Tier 1 agents in parallel

`buildReview()` fires five Tier 1 API calls simultaneously via `Promise.allSettled()`. Each call has:

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

### Tier 2 — Conditional skills

In addition to the five Tier 1 agents, `detectTier2Skills()` in `src/tier2.ts` inspects the PR's file paths, diff content, labels, and size to decide whether additional specialized agents should run. Tier 2 agents fire alongside Tier 1 in the same `Promise.allSettled()` batch — there is no second pass.

| Skill | Trigger |
| --- | --- |
| **type-design-analyzer** | PR changes `.ts`/`.tsx`/`.py`/`.pyi` files AND the diff contains type definitions (`interface`, `type =`, `class`, `enum`, `@dataclass`, `TypedDict`, `Protocol`, etc.) |
| **comment-analyzer** | PR changes documentation files (`.md`, `.mdx`, `.rst`, `.txt`), OR adds ≥5 comment lines, OR contains substantial inline documentation changes in a small diff |
| **security-auditor** | Any changed path matches security-sensitive patterns (`auth`, `token`, `jwt`, `payment`, `credential`, `secret`, etc.), OR the PR title/body mentions ≥2 security keywords, OR the diff contains crypto/token-handling code |
| **architect-review** | PR is labelled `architecture` or `breaking-change`, OR ≥3 architectural boundary files change (routes, services, config, schema, migrations), OR the PR is ≥300 lines across ≥10 files |

When Tier 2 skills activate, the review body includes an "Additional skills activated" section listing which skills ran and why.

### Layer 2 — Merge

After all agents settle, `mergeReviews()` combines their outputs:

**Inline comments** — deduplicated by `path:line` key. When two agents flag the same location, the `REQUEST_CHANGES` agent's comment wins (more conservative finding).

**General findings** — deduplicated by title (case-insensitive).

**Verdict** — three possible outcomes:

- `REQUEST_CHANGES` — any agent returned it
- `COMMENT` — no agent requested changes, but there are general findings or inline comments
- `APPROVE` — all agents returned `COMMENT` AND the merged review has zero general findings AND zero valid inline comments. This signals a clean PR with nothing to flag.

**Summary** — non-empty, non-trivial summaries from each agent are joined. "No issues found" summaries are filtered out.

## Diff anchor validation

Before submission, every inline comment is validated against the set of valid right-side line numbers in the diff (`collectRightSideLines()`). Comments referencing a path not in the diff, a line not in the valid set, a backwards range (`start_line >= line`), or `start_line: 0` are dropped silently. All valid comments are submitted — there is no cap.

## Fallback retry

If the GitHub Reviews API rejects the POST, the bot retries up to 3 times with exponential backoff (3s, 6s between attempts), each time with the full payload including inline comments.

If all 3 attempts fail, the bot posts a regular PR comment instead of a formal review. The comment includes the error message, the full review body (summary and general findings), and every inline comment listed by `file:line` reference. This ensures findings are never silently lost. The original error is also thrown so it appears in Vercel logs.

## Cross-bot deduplication

Before running agents, each bot fetches all existing reviews on the PR and classifies them:

- **Sister bot** (the other AI bot in this deployment — detected by its `Reviewed commit:` footer): included only if it reviewed the same commit SHA
- **External bots** (Code Rabbit, Copilot, Sonar, etc.): always included — the 7.5-minute review delay is specifically to let these finish before our bots run
- **This bot's own prior reviews**: excluded

Collected reviews are injected into the user message sent to every agent:

```text
Prior reviews by other AI reviewers on this commit — do not re-report any finding already mentioned below:

### codex-review-bot
...
**CodeRabbit**
...
```

If Code Rabbit already flagged a SQL injection risk, our agents see it and focus on what hasn't been covered yet. The idempotency check (skipping a re-review of the same commit by this bot) is scoped to this bot's own reviews only and does not trigger on external bot reviews.

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
