# Project Instructions for AI Agents

This file provides context and conventions for AI coding agents working on this codebase.

## Build & Test

```bash
npm install
npm run typecheck    # tsc --noEmit — must pass before any commit
npm run lint         # biome check — must pass before any commit
npm run test         # vitest run (216 tests) — must pass before any commit
npm run dev          # vercel dev — local server on :3000
```

All three quality gates must pass before opening a PR.

## Architecture Overview

This is a GitHub App that deploys two bots (Claude via Anthropic, Codex via OpenAI) from a single Vercel deployment. Each bot runs five Tier 1 review agents (plus conditional Tier 2 agents) in parallel and merges their findings into a single structured review posted to GitHub.

### Request flow

```text
POST /api/github/webhook           (Claude bot)
POST /api/github/webhook-openai    (Codex bot)
  → signature verification (HMAC-SHA256)
  → issue_comment.created → parseReviewCommand() → maybeSubmitReview()
  → pull_request.opened/synchronize/ready_for_review → maybeSubmitReview() (if REVIEW_ENABLED)
```

### Two-layer review architecture

**Agent layer** (`src/review.ts` → `runAgent()`): Five Tier 1 agents (plus any activated Tier 2 agents) fire in parallel via `Promise.allSettled()`. Each call uses a focused system prompt (`buildAgentSystemPrompt(skillPath, customPrompt)` from `src/prompt.ts`) with prompt caching enabled. All agents share the same user message (`buildUserMessage()` — PR metadata + serialized diff). `Promise.allSettled` ensures one agent failure doesn't abort the whole review.

**Merge layer** (`src/review.ts` → `mergeReviews()`): After all agents settle, findings are merged:

- Inline comments deduplicated by `path:line` key; when two agents flag the same location, the one from a `REQUEST_CHANGES` agent wins (more conservative)
- General findings deduplicated by title (case-insensitive)
- Final `event`: `REQUEST_CHANGES` if any agent returned it; `APPROVE` if all agents found zero issues; `COMMENT` otherwise

**Diff anchor validation** (`buildReviewComments()`): Before submission, every inline comment is checked against the set of valid right-side line numbers extracted from the unified diff (`collectRightSideLines()`). Comments referencing lines not in the diff are dropped silently rather than erroring the review.

**Fallback retry** (`src/github-app.ts` → `maybeSubmitReview()`): If the GitHub Reviews API rejects the POST, the bot retries up to 3 times with exponential backoff. If all retries fail, it posts a regular PR comment preserving the findings.

### Key files

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Environment variable parsing and defaults (both Claude and OpenAI configs) |
| `src/commands.ts` | Slash command parsing, `isTrustedAuthorAssociation()` |
| `src/github-app.ts` | Octokit setup, draft PR check, submit + fallback retry |
| `src/prompt.ts` | `buildUserMessage()`, `buildAgentSystemPrompt(skillPath, customPrompt)` |
| `src/review.ts` | `runAgent()`, `mergeReviews()`, `buildReviewComments()`, `buildReview()` |
| `src/models.ts` | AI model creation (`createAIModel()`), token cost calculation |
| `src/router.ts` | PR tier classification (`classifyTier()`), model selection (`routeModel()`) |
| `src/tier2.ts` | Tier 2 skill detection (`detectTier2Skills()`) |
| `src/audit.ts` | Full repository audit logic (`auditRepo()`) |
| `src/cli.ts` | CLI entry point for `ai-review` command |
| `src/testing.ts` | Shared test fixtures (`buildModelReview`, `buildGenerateObjectResponse`, etc.) |
| `skills/*.md` | Vendored skill frameworks loaded at runtime by `buildAgentSystemPrompt()` |

### Local audit

The CLI supports two subcommands for offline code review of the working tree:

- `ai-review audit [--full] [--dry-run] [--out <dir>] [--extra <text>] [--json]` — Audits the local working tree (changed files by default; `--full` for the entire codebase). Runs both Claude and OpenAI provider passes in parallel, writes structured JSON + Markdown artifacts to `.ai-review/`, and (unless `--dry-run`) opens a draft synthetic-base review PR labeled `AI audit` for inline review. Optionally posts as a GitHub issue if the PR creation fails due to insufficient permissions.

- `ai-review ready [pr#]` — Retargets the audit PR onto the default branch and marks it ready for review (defaults to the PR recorded in `.ai-review/audit-anthropic.json` from the last audit). Use after addressing findings to collapse the diff to fixes-only and merge cleanly.

Reference: `docs/superpowers/specs/2026-06-08-local-audit-review-pr-design.md`

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
- **Biome** for lint + format; run `npm run lint -- --write` to auto-fix
- **Conventional commits** for commit messages (`feat:`, `fix:`, `refactor:`, etc.)
- **No mocking of real skill files in tests** — `./prompt.js` is mocked wholesale in `review.test.ts`; the test mock exports `buildUserMessage` and `buildAgentSystemPrompt`
- **Structured output via tool use** — the `submit_review` tool schema is the single source of truth for `ModelReview`; the model is forced to call it via `tool_choice: { type: "tool", name: "submit_review" }`
- **Prompt caching** — `cache_control: { type: "ephemeral" }` on every agent's system prompt; the user message (diff) is not cached because it changes per PR

## Adding or replacing a skill

**Tier 1 skill:**
1. Add or update a `.md` file in `skills/`
2. Add its path to the `TIER1_SKILLS` array in `src/review.ts`
3. Run `npm test` — no test changes required unless the skill changes the output schema

**Tier 2 skill:**
1. Add a `.md` file in `skills/`
2. Add a detection function in `src/tier2.ts` (pattern: `shouldRunXxx(ctx) → string | null`)
3. Register it in the `TIER2_DETECTORS` array in `src/tier2.ts`
4. Add tests in `src/tier2.test.ts`

## Environment variables

See `.env.example` for all variables. Key groups:

- **Claude bot:** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`
- **Codex bot:** `OPENAI_APP_ID`, `OPENAI_APP_PRIVATE_KEY`, `OPENAI_APP_WEBHOOK_SECRET`, `OPENAI_API_KEY`
- **Shared behavior:** `REVIEW_ENABLED` (default `true`), `REVIEW_DELAY_SECONDS` (default `540` — initial auto-review delay), `REVIEW_RESYNC_DELAY_SECONDS` (default `300` — re-review delay after a push), `REVIEW_COMMAND`, `CUSTOM_REVIEW_PROMPT`, `AGENT_CONCURRENCY` (default `1` — max review agents run in parallel per PR; kept sequential to stay under provider ITPM rate limits), `REVIEW_TIER2_ENABLED` (default `false` — Tier 2 review skills stay off until the QStash scheduler frees the full 800s budget; enabling runs ~8 agents and risks the maxDuration kill)
