# ai-review-bot

[![Discord](https://img.shields.io/discord/1486035859747897414?logo=discord&label=Discord&color=5865F2)](https://discord.com/channels/1486035859747897414/1509515273076473975) [![Join Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2?logo=discord&logoColor=white)](https://discord.gg/Fjc9zYHZyV)
[![Docs](https://img.shields.io/badge/docs-online-blue)](https://joeblackwaslike.github.io/ai-review-bot/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![Deploy](https://img.shields.io/badge/deploy-vercel-black?logo=vercel)](https://vercel.com/joe-blacks-projects/ai-review-bot)

**ai-review-bot** ships two parallel AI code reviewers in one Vercel deployment — a **Claude bot** (Anthropic) and a **Codex bot** (OpenAI). Each runs as its own GitHub App with its own icon, so you can tell them apart in your PR timeline. Both post independently; you get two expert opinions side by side on every review.

Both bots run **five specialized agents in parallel** — each focused on a different review framework — then merge their findings into a single deduplicated review comment.

> **[Full documentation →](https://joeblackwaslike.github.io/ai-review-bot/)**

## Two bots, one deployment

| | Claude bot | Codex bot |
|---|---|---|
| **Provider** | Anthropic | OpenAI |
| **Models** | Haiku → Sonnet → Opus (by PR complexity) | GPT-5 → o4-mini → o3 (by PR complexity) |
| **Reasoning** | Extended thinking (`thinkingBudget`) | Reasoning effort (`low`/`medium`/`high`) |
| **Webhook** | `/api/github/webhook` | `/api/github/webhook-openai` |
| **Default prefix** | `ai-review-bot` | `codex-review-bot` |

Both bots share the same five review agents and the same slash command. Install both GitHub Apps on a repo and every `/ai-review` triggers two independent reviews — one from each provider.

## How it works

1. Comment `/ai-review` on any pull request
2. The bot fetches the diff and PR metadata from GitHub
3. **Five review agents run in parallel**, each applying one focused framework to the diff:
   - **Bug detection** (`pr-review-toolkit:code-reviewer`) — project-standard compliance, ≥80% confidence threshold
   - **Error handling** (`pr-review-toolkit:silent-failure-hunter`) — swallowed exceptions, empty catch blocks, silent fallbacks
   - **Test coverage** (`pr-review-toolkit:pr-test-analyzer`) — gaps on critical paths, criticality scoring 1–10
   - **Security** (`security-scanning:security-sast`) — injection, path traversal, XSS, hardcoded secrets
   - **Multi-axis quality** (`addyosmani:code-review-and-quality`) — correctness, readability, architecture, performance
4. The **merge layer** deduplicates findings (same `path:line` → one comment, more conservative finding wins), then emits a single verdict: `REQUEST_CHANGES` if any agent flagged a blocking issue, `COMMENT` otherwise
5. Inline comment anchors are validated against the actual diff before submission; invalid anchors are silently dropped
6. The structured review is posted to GitHub with inline comments, general findings, and a summary

## Architecture

```
webhook → buildReview()
              │
              ├── runAgent(code-reviewer)           ┐
              ├── runAgent(silent-failure-hunter)    │  Promise.allSettled()
              ├── runAgent(pr-test-analyzer)         │  (5 parallel API calls)
              ├── runAgent(security-sast)            │
              └── runAgent(code-review-and-quality)  ┘
                              │
                         mergeReviews()
                              │
                    ┌─────────┴──────────┐
               dedup by            verdict:
               path:line          REQUEST_CHANGES
               (conservative       if any agent
                wins)              flagged P0/P1
                              │
                     buildReviewComments()
                     (validate against diff)
                              │
                    POST to GitHub Reviews API
```

Model selection is automatic. The router classifies each PR into a tier based on size, file paths, and labels:

| Tier | Trigger | Claude | Codex |
|------|---------|--------|-------|
| `trivial` | Doc-only, <20 lines | Haiku | GPT-5 |
| `normal` | Standard PR | Sonnet | GPT-5 |
| `complex` | >500 lines or auth/crypto/db paths | Sonnet + thinking | o4-mini medium |
| `deep` | `deep-review` label | Opus + thinking | o3 high |

## Quick start

See **[Quick Start →](https://joeblackwaslike.github.io/ai-review-bot/quick-start)** for the full setup guide. The short version:

1. Create a **Claude GitHub App** and a **Codex GitHub App** (or just one if you only want one provider)
2. Fork and deploy to Vercel, adding all env vars
3. Point each app's webhook at its respective endpoint
4. Install both apps on your repos
5. Comment `/ai-review` on a PR — you'll see two reviews appear

## Commands

```text
/ai-review                               # standard review (both bots)
/ai-review focus on security             # with extra instructions
/ai-review --force                       # re-review same commit
/ai-review --force check for regressions # force + extra instructions
```

Only comments from `OWNER`, `MEMBER`, and `COLLABORATOR` author associations trigger a review. Draft PRs are skipped automatically. Reviews are idempotent per SHA unless you pass `--force`.

## Environment variables

### Claude bot (Anthropic)

| Variable | Required | Description |
|---|---|---|
| `GITHUB_APP_ID` | ✓ | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | ✓ | PKCS#8 private key PEM (`\n` for newlines) |
| `GITHUB_WEBHOOK_SECRET` | ✓ | HMAC secret for webhook signature verification |
| `ANTHROPIC_API_KEY` | ✓ | Anthropic API key (`sk-ant-…`) |

### Codex bot (OpenAI)

| Variable | Required | Description |
|---|---|---|
| `OPENAI_APP_ID` | ✓ | Numeric GitHub App ID for the Codex app |
| `OPENAI_APP_PRIVATE_KEY` | ✓ | PKCS#8 private key PEM (`\n` for newlines) |
| `OPENAI_APP_WEBHOOK_SECRET` | ✓ | HMAC secret for the Codex app webhook |
| `OPENAI_API_KEY` | ✓ | OpenAI API key (`sk-…`) |

### Shared behavior

| Variable | Default | Description |
|---|---|---|
| `REVIEW_ENABLED` | `true` | Set to `false` to disable auto-review on PR open/push |
| `REVIEW_COMMAND` | `/ai-review` | Slash command that triggers both bots |
| `REVIEW_DELAY_SECONDS` | `450` | Seconds before auto-review fires on PR open (7.5 min) |
| `CUSTOM_REVIEW_PROMPT` | — | Extra instructions appended to every agent's system prompt |

See [Configuration →](https://joeblackwaslike.github.io/ai-review-bot/configuration) and [`.env.example`](.env.example).

## Development

```bash
npm install
npm run dev          # vercel dev (local server on :3000)
npm run typecheck    # tsc --noEmit
npm run lint         # biome check
npm run test         # vitest run
```

### Local webhook testing

```bash
# Terminal 1 — proxy for Claude bot
npx smee-client --url https://smee.io/<channel-1> \
  --target http://localhost:3000/api/github/webhook

# Terminal 2 — proxy for Codex bot
npx smee-client --url https://smee.io/<channel-2> \
  --target http://localhost:3000/api/github/webhook-openai

# Terminal 3 — local server
cp .env.example .env   # fill in your values
npm run dev
```

## GitHub Action

Run a full-repo audit (not a PR review) in any CI workflow:

```yaml
- uses: joeblackwaslike/ai-review-bot@v0.1.0
  with:
    github-app-id: ${{ secrets.GITHUB_APP_ID }}
    github-app-private-key: ${{ secrets.GITHUB_APP_PRIVATE_KEY }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Project structure

```
api/
  github/webhook.ts           # Claude bot webhook handler
  github/webhook-openai.ts    # Codex bot webhook handler
  health.ts                   # GET /api/health
  debug.ts                    # GET /api/debug
src/
  config.ts       # env var parsing — getConfig() and getOpenAIAppConfig()
  router.ts       # tier classification and model routing (both providers)
  models.ts       # model instantiation via Vercel AI SDK
  commands.ts     # slash command parsing, author association check
  github-app.ts   # Octokit setup, review submission + fallback retry
  prompt.ts       # buildUserMessage(), buildAgentSystemPrompt()
  review.ts       # agent layer, merge layer, diff anchor validation
  audit.ts        # full-repo audit for CLI / GitHub Action
  cli.ts          # npx ai-review entry point
  testing.ts      # test fixtures
skills/
  code-reviewer.md
  silent-failure-hunter.md
  pr-test-analyzer.md
  security-sast.md
  code-review-and-quality.md
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
