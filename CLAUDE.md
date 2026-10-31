# Project Instructions for AI Agents

This file provides context and conventions for AI coding agents working on this codebase.

## Build & Test

```bash
pnpm install
pnpm typecheck    # tsc --noEmit — must pass before any commit
pnpm lint         # biome check — must pass before any commit
pnpm test         # vitest run (1334 tests, 4 skipped) — must pass before any commit
pnpm dev          # vercel dev — local server on :3000
```

All three quality gates must pass before opening a PR.

## Architecture Overview

This is a GitHub App that deploys two bots (Claude via Anthropic, Codex via OpenAI) from a single Vercel deployment. Each bot runs five Tier 1 review agents (plus conditional Tier 2 agents) in parallel and merges their findings into a single structured review posted to GitHub.

### Request flow

```text
POST /api/github/webhook           (Claude bot)
POST /api/github/webhook-openai    (Codex bot)
  → signature verification (HMAC-SHA256)
  → issue_comment.created → parseReviewCommand() → maybeSubmitReview()   (direct, no delay)
  → pull_request.opened/synchronize/ready_for_review → scheduleReview() (QStash callback, delayed only if REVIEW_*DELAY_SECONDS > 0; if REVIEW_ENABLED)

POST /api/github/review-run        (QStash delayed callback)
  → verify Upstash-Signature (Receiver.verify, URL-bound)
  → runScheduledReview() → head-SHA staleness check (coalesce pushes) → maybeSubmitReview()
```

**Why the QStash scheduler:** The review delay (now opt-in, default 0) used to be an in-process `setTimeout`, which burned the Vercel function budget (300s on Hobby) doing nothing — killing large Tier 2 reviews mid-run. Now the `pull_request` handler publishes a QStash message (with a `delay` only when the configured delay is above 0) and returns immediately; QStash invokes `/api/github/review-run`, so the review runs fresh with the full budget. **Coalescing** concurrent pushes is done by a head-SHA staleness check in `runScheduledReview` (the message carries the SHA current at publish; if the PR head has moved past it, the run no-ops as `superseded`) — NOT by `deduplicationId`, which only dedups GitHub webhook redeliveries and cannot cancel an already-scheduled message. **Graceful fallback:** if QStash is unconfigured (`QSTASH_TOKEN`/`PUBLIC_URL` absent), `scheduleReview` returns `null` and the handler falls back to an inline review (sleeping first only if a delay is configured) — a review is never dropped. `PUBLIC_URL` must be the stable prod origin: QStash signs the destination URL into the JWT, so publish-URL and verify-URL must be byte-identical (see `src/scheduler.ts`).

### Two-layer review architecture

**Agent layer** (`src/review.ts` → `runAgent()`): Five Tier 1 agents (plus any activated Tier 2 agents) fire in parallel via `Promise.allSettled()`. Each call uses a focused system prompt (`buildAgentSystemPrompt(skillPath, customPrompt)` from `src/prompt.ts`) with prompt caching enabled. All agents share the same user message (`buildUserMessage()` — PR metadata + serialized diff). `Promise.allSettled` ensures one agent failure doesn't abort the whole review.

**Merge layer** (`src/review.ts` → `mergeReviews()`): After all agents settle, findings are merged:

- Inline comments deduplicated by `path:line` key; when two agents flag the same location, the one from a `REQUEST_CHANGES` agent wins (more conservative)
- **Near-duplicate claim collapsing** (`src/claim-dedupe.ts`, tuned reviewers only): agents rarely anchor to the identical line, so the exact-key pass above misses one claim arriving on six adjacent lines. `dedupeClaims()` folds findings in the same file, within 30 lines, that share a code identifier or substantial title overlap. Measured on the live corpus: 403 of 1180 anthropic findings (34%) are restatements
- General findings deduplicated by title (case-insensitive)
- Final `event`: `REQUEST_CHANGES` if any agent returned it; `APPROVE` if all agents found zero issues; `COMMENT` otherwise

Settled repeats are dropped per agent before this merge, and a re-review round with nothing new posts nothing (see `src/ledger/` and `docs/superpowers/specs/2026-10-28-ledger-repeat-suppression-design.md`).

**Diff anchor validation** (`buildReviewComments()`): Before submission, every inline comment is checked against the set of valid right-side line numbers extracted from the unified diff (`collectRightSideLines()`). Comments referencing lines not in the diff are dropped silently rather than erroring the review.

**Fallback retry** (`src/github-app.ts` → `maybeSubmitReview()`): If the GitHub Reviews API rejects the POST, the bot retries up to 3 times with exponential backoff. If all retries fail, it posts a regular PR comment preserving the findings.

### Key files

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Environment variable parsing and defaults (both Claude and OpenAI configs) |
| `src/commands.ts` | Slash command parsing, `isTrustedAuthorAssociation()` |
| `src/github-app.ts` | Octokit setup, draft PR check, submit + fallback retry, `runScheduledReview()` |
| `src/scheduler.ts` | QStash transport: `scheduleReview()` (delayed publish), `verifyQStashSignature()`, `reviewRunCallbackUrl()` |
| `src/prompt.ts` | `buildUserMessage()`, `buildAgentSystemPrompt(skillPath, customPrompt)` |
| `src/review.ts` | `runAgent()`, `mergeReviews()`, `buildReviewComments()`, `buildReview()` |
| `src/models.ts` | AI model creation (`createAIModel(selection, auth?)`), token cost calculation |
| `src/auth.ts` | Local subscription/OAuth + API-key resolution (`resolveAnthropicAuth()`, `resolveOpenAIAuth()`); custom-fetch wrappers. **CLI-only — never import from webhook paths** |
| `src/router.ts` | PR tier classification (`classifyTier()`), model selection (`routeModel()`) |
| `src/tier2.ts` | Tier 2 skill detection (`detectTier2Skills()`) |
| `src/claim-dedupe.ts` | Near-duplicate claim clustering (`dedupeClaims()`, `isSameClaim()`) |
| `src/reviewer-tuning.ts` | Signal-quality switches (`REVIEWER_TUNING`) — unified across both providers since ai-review-bot-5zu; previously anthropic-only |
| `src/audit.ts` | Full repository audit logic (`auditRepo()`), local audit (`runLocalAudit()`), local review (`runLocalReview()`) |
| `src/report.ts` | `docs/code-reviews/` report writer (`formatReviewReport()`, `allocateReportPath()`) |
| `src/cli.ts` | CLI entry point for `ai-review` command |
| `src/watch.ts` | `watchPr()` — polls an already-open PR and re-reviews it on head-SHA change via `maybeSubmitReview`, using local subscription auth; backs `ai-review watch` |
| `src/testing.ts` | Shared test fixtures (`buildModelReview`, `buildGenerateObjectResponse`, etc.) |
| `src/replay/` | Offline replay harness — records, labels, and replays PR review rounds to measure false-positive rate, recycling, and convergence; backs `ai-review replay`. See `docs/superpowers/specs/2026-10-27-review-replay-harness-design.md` |
| `src/baseline.ts` | `deriveBaseline()` derives a review baseline from GitHub: the latest own review's markers (sha, review count) plus the ledger's open findings; replaces KV as the source of prior state on a cold start |
| `src/agent-failure.ts` | Classifies a thrown agent error into a failure class and decides whether it is worth one retry |
| `src/agent-log.ts` | Per-agent outcome records, the `agents` marker in the review body, and the local JSONL log sink |
| `src/review-metadata.ts` | Reads the `ai-review:key=value` marker block above the review footer, ignoring quoted or duplicated markers |
| `src/ledger/` | Platform-neutral ledger of review findings and their dispositions rebuilt from GitHub threads, claim matching across rounds, suppression of settled repeats; see `docs/superpowers/specs/2026-10-28-ledger-repeat-suppression-design.md` |
| `skills/*.md` | Vendored skill frameworks loaded at runtime by `buildAgentSystemPrompt()` |

### Local audit & review

The CLI supports four subcommands for offline code review of the working tree (plus `ai-review watch` for an already-open PR, and `ai-review replay` for offline review-accuracy measurement — see below):

- `ai-review review [--full | --commit <sha>] [--slug <slug>] [--title <t>] [--out <dir>] [--extra <text>] [--json]` — Runs the full multi-agent review against local changes (default), the full tree (`--full`), or a specific commit (`--commit`), and writes a round-numbered Markdown report with YAML front-matter into `docs/code-reviews/` (no PR). Auth per provider: API key → explicit OAuth env token → logged-in `codex`/`claude` subscription (local, personal use only; never wired into webhook paths — see `src/auth.ts`). The `/code-review` slash command wraps it with doc-only / `--fix` / `--propose` modes.

- `ai-review audit [--full] [--dry-run] [--out <dir>] [--extra <text>] [--json]` — Audits the local working tree (changed files by default; `--full` for the entire codebase). Runs both Claude and OpenAI provider passes in parallel, writes structured JSON + Markdown artifacts to `.ai-review/`, and (unless `--dry-run`) opens a draft synthetic-base review PR labeled `AI audit` for inline review. Optionally posts as a GitHub issue if the PR creation fails due to insufficient permissions.

- `ai-review ready [pr#]` — Retargets the audit PR onto the default branch and marks it ready for review (defaults to the PR recorded in `.ai-review/audit-anthropic.json` from the last audit). Use after addressing findings to collapse the diff to fixes-only and merge cleanly.

- `ai-review watch --pr <n> [--repo <owner/name>] [--provider anthropic|openai] [--interval <seconds>] [--no-circuit-breaker]` — Polls an already-open PR and re-reviews it on every push, posting through the same GitHub App bot identities production uses, driven by local subscription auth instead of a funded API key. Personal, local use only (same ToS boundary as `review`/`audit`); exits when the PR merges or closes. A restarted watcher no longer forces a cold review; it reviews the delta since the bot's last review on that PR, and a head the bot already reviewed ends as a "no new review" skip. After a hard kill with KV configured, "commit already claimed" skips can appear for up to 1200 seconds. Defaults to a 300s (5 min) poll interval — see `ai-review-bot-599` follow-up below for why. See `src/watch.ts` and `docs/superpowers/specs/2026-08-16-local-pr-watch-subscription-auth-design.md`. Both `--provider anthropic` and `--provider openai` are dogfoodable — `--provider openai` was fixed in `ai-review-bot-wt8`: the ChatGPT/Codex Responses-API backend rejects `stream:false` outright for OAuth-authenticated requests, and its `response.completed` event's embedded `response.output` is always empty (content must be accumulated from the incremental `response.output_item.done` events, same as a real streaming client). `makeCodexFetch`'s `parseCodexSSEResponse` (`src/auth.ts`) reconstructs a plain JSON response from the SSE stream so `generateObject` is unaware streaming ever happened; verified live end-to-end against this repo's own PR #67. The hosted webhook path (API-key only) is unaffected either way. **Do not leave `watch` running unattended at a fast interval (`--interval 45`-`60`) while actively iterating on its own findings** — a push into a live watcher triggers a fresh review within minutes, and the fix-then-repush cycle can outrun a human/agent's ability to notice the reviewer has converged, producing an unbounded review-nitpick loop rather than a bounded review-fix loop. Pause or kill the watcher before pushing a batch of review-response fixes; restart it (with a fast `--interval` override if you're actively supervising it) only for a final confirmation pass. See `docs/post-mortem-review-loop-churn.md` — this exact pattern cost ~2.5 hours across PRs #67/#68 before being caught. **Mechanical circuit breaker (`ai-review-bot-599`):** the prose guidance above was already documented before that incident and was recognized-but-not-enforced mid-run, so `watchPr` (`src/watch.ts`) now stops itself once a single provider posts 3 reviews within a 15-minute rolling window, logging `circuit breaker tripped` and exiting with `reason: "circuit-breaker"` instead of relying on an operator or subagent to notice and self-limit. Pass `--no-circuit-breaker` only for a deliberate, already-supervised run (e.g. a final confirmation pass) — it disables the guard entirely for that session. **The circuit breaker is a separate lever from the poll interval** — it caps how many reviews a session can *post* regardless of cadence, but doesn't itself make fast polling safe; the 300s default interval is the first line of defense (avoids catching a mid-flight fix-and-repush cycle at all), the breaker is the backstop for whatever pushes through anyway. Override with `--interval` for a supervised fast pass (e.g. dogfooding a fix to `watch.ts` itself).

Reference: `docs/superpowers/specs/2026-06-08-local-audit-review-pr-design.md`

- `ai-review replay [--fixtures <dir>]` / `ai-review replay --record <pr-url> --provider anthropic|openai --bot <login>` / `ai-review replay --live [--rounds <n>] [--max-cost <usd>]` — Deterministic offline replay of recorded review rounds: measures false-positive rate, claim recycling, and convergence against auto-labeled fixtures (provisional until an agent verifies them against the PR threads and Codex cross-checks them; items the two models disagree on stay unadjudicated). `--record` captures a real PR's rounds/threads/reactions via `gh` into `src/replay/fixtures/`; the default (no flags) replays existing fixtures and fails on confirmed-label guard violations (warns on provisional ones); `--live` is an opt-in, cost-capped tier that re-runs the audit pipeline against confirmed pairs only — it never gates CI. If any `*.classes.json` fixture is present, the default run also prints a classification report (`src/replay/classify.ts`, breaking rejected first-seen findings into filler/stale/contradicted/speculative/other, by rule and by model, provisional until adjudicated) and a filter-margin report (`src/replay/filter-margin.ts`, measuring what the candidate retraction rule in `src/replay/retraction-rule.ts` would remove against those classes; the rule is a measurement only and is not applied in the merge). See `docs/superpowers/specs/2026-10-27-review-replay-harness-design.md` and `docs/superpowers/specs/2026-10-29-claude-first-pass-accuracy-design.md` for the design and `src/replay/`.

`watch`, `review` and `audit` also append one JSON line per agent outcome to `~/.ai-review/logs/agents.jsonl`, or to the path in `AI_REVIEW_LOG_FILE` when it is set. The hosted webhook path does not write it.

### Agent skills

Each skill file is loaded by `buildAgentSystemPrompt(skillPath, ...)` in `src/prompt.ts`. YAML frontmatter is stripped at load time.

**Tier 1** (always run on every PR):

| Skill file | Framework | Focus |
| --- | --- | --- |
| `skills/code-reviewer.md` | `pr-review-toolkit:code-reviewer` | Bug detection, project compliance, ≥80% confidence threshold |
| `skills/silent-failure-hunter.md` | `pr-review-toolkit:silent-failure-hunter` | Swallowed exceptions, empty catch blocks, silent fallbacks |
| `skills/pr-test-analyzer.md` | `pr-review-toolkit:pr-test-analyzer` | Test coverage gaps, criticality scoring 1–10 |
| `skills/security-sast.md` | `security-scanning:security-sast` | Injection, path traversal, XSS, hardcoded secrets |
| `skills/code-review-and-quality.md` | `addyosmani:code-review-and-quality` | 5-axis checklist: correctness, readability, architecture, security, performance |

**Tier 2** (conditionally activated by `detectTier2Skills()` in `src/tier2.ts`):

| Skill file | Trigger |
| --- | --- |
| `skills/type-design-analyzer.md` | PR changes typed files (`.ts`/`.tsx`/`.py`) with type definitions |
| `skills/comment-analyzer.md` | PR changes doc files or adds ≥5 comment lines |
| `skills/security-auditor.md` | PR touches security-sensitive paths or keywords |
| `skills/architect-review.md` | PR modifies architectural boundaries, or ≥300 lines across ≥10 files |

`skills/code-review-excellence/SKILL.md` is not used at runtime — it was the source document for the review mindset philosophy embedded in the skill files above.

## Conventions & Patterns

- **TypeScript ESM** — `"type": "module"` in `package.json`; all imports use `.js` extensions even for `.ts` source files
- **No default exports** — named exports only
- **Vitest** for tests; test files colocated with source (`src/*.test.ts`)
- **Biome** for lint + format; run `pnpm lint -- --write` to auto-fix
- **Conventional commits** for commit messages (`feat:`, `fix:`, `refactor:`, etc.)
- **No mocking of real skill files in tests** — `./prompt.js` is mocked wholesale in `review.test.ts`; the test mock exports `buildUserMessage` and `buildAgentSystemPrompt`
- **Structured output via `generateObject`** — `ModelReviewSchema` (zod, `src/review.ts`) is the single source of truth for `ModelReview`. The AI SDK sends it as native structured output (`output_config.format`) on Claude 5.5. Never force a tool call instead: Opus/Sonnet 5.5 return a 400 on forced `tool_choice`, and `@ai-sdk/anthropic` < 3.0.135 fell back to exactly that for 5.5 model IDs it didn't recognize (ai-review-bot-j2j)
- **Prompt caching** — `cache_control: { type: "ephemeral" }` on every agent's system prompt; the user message (diff) is not cached because it changes per PR

## Adding or replacing a skill

**Tier 1 skill:**
1. Add or update a `.md` file in `skills/`
2. Add its path to the `TIER1_SKILLS` array in `src/review.ts`
3. Run `pnpm test` — no test changes required unless the skill changes the output schema

**Tier 2 skill:**
1. Add a `.md` file in `skills/`
2. Add a detection function in `src/tier2.ts` (pattern: `shouldRunXxx(ctx) → string | null`)
3. Register it in the `TIER2_DETECTORS` array in `src/tier2.ts`
4. Add tests in `src/tier2.test.ts`

## Environment variables

See `.env.example` for all variables. Key groups:

- **Claude bot:** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`
- **Codex bot:** `OPENAI_APP_ID`, `OPENAI_APP_PRIVATE_KEY`, `OPENAI_APP_WEBHOOK_SECRET`, `OPENAI_API_KEY`
- **Shared behavior:** `REVIEW_ENABLED` (default `true`), `REVIEW_DELAY_SECONDS` (default `0` — initial auto-review delay; reviews start immediately), `REVIEW_RESYNC_DELAY_SECONDS` (default `0` — re-review delay after a push), `REVIEW_COMMAND`, `CUSTOM_REVIEW_PROMPT`, `AGENT_CONCURRENCY` (default `4` — max review agents run in parallel per PR; the first agent runs alone so its prompt-cache write is readable by the rest. Measured on a 14-file diff: 212s at 1 vs 75s at 4, same cost, no 429s; drop it if a provider's ITPM limit starts rejecting the burst), `REVIEW_AGENT_BUDGET_SECONDS` (default `210` — wall-clock deadline for agents, sized under the routes' 300s Vercel Hobby `maxDuration`, leaving ~90s after the agents for the summary call, review POST and state writes; the clock starts after the PR/review fetches, and on the inline (no-QStash) fallback the delay is subtracted from it. It is a hard deadline: no agent starts past it and a running agent is aborted at it (`abortSignal`), both counted as skipped; the review is submitted with what completed, with a `⏱ Partial review` notice on the body. Do not set it above ~210 on Hobby or the function is killed with nothing posted), `REVIEW_TIER2_ENABLED` (default `true` — Tier 2 review skills; QStash carries the delay so the delay never burns the function budget. Set `false` to force off)
- **QStash scheduler (optional, recommended):** `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_URL`, `PUBLIC_URL` (stable prod origin, no trailing slash). When set, the `pull_request` review runs as a QStash callback to `/api/github/review-run` (delayed when a delay is configured) instead of inline in the webhook function. Absent these, the bot falls back to the inline path (with an in-process delay if one is configured) — never drops a review. `PUBLIC_URL` must be byte-identical at publish and verify (QStash signs the URL into the JWT). **QStash is region-specific:** the SDK default endpoint routes to EU (`eu-central-1`); a US-region account must set `QSTASH_URL=https://qstash-us-east-1.upstash.io` (token + signing keys must match that region) or every publish fails with `user not found in this region`.

## Production deployment

- **Vercel project:** `ai-review-bot` (team `joe-blacks-projects`).
- **Production domain:** `https://claude-review-bot.vercel.app` — this is the only public, auth-free origin and the value `PUBLIC_URL` is set to. The GitHub App webhooks (both the Claude bot and the Codex bot) also point here.
- ⚠️ **The domain is `claude-review-bot`, NOT `ai-review-bot`, on purpose.** The project was renamed to `ai-review-bot` long ago, but `ai-review-bot.vercel.app` is owned by a *different* Vercel team and `.vercel.app` subdomains are globally unique — so it can't be claimed. Don't "fix" the mismatch by pointing anything at `ai-review-bot.vercel.app` (it 404s / `DEPLOYMENT_NOT_FOUND`). The team-scoped aliases (`ai-review-bot-joe-blacks-projects.vercel.app`) have Deployment Protection enabled (return 401) and can't serve webhooks either.
- Changing the domain would require repointing `PUBLIC_URL` **and** both GitHub App webhook URLs together.
