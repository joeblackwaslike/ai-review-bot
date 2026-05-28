# ai-review-bot

[![Docs](https://img.shields.io/badge/docs-online-blue)](https://joeblackwaslike.github.io/ai-review-bot/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![Deploy](https://img.shields.io/badge/deploy-vercel-black?logo=vercel)](https://vercel.com/joe-blacks-projects/ai-review-bot)

**ai-review-bot** is a GitHub App that posts AI-powered code reviews when you comment `/ai-review` on a pull request. It runs on Vercel, uses Anthropic's Claude SDK, and submits structured reviews with inline comments anchored to the actual diff.

Unlike single-prompt review bots, it runs **five specialized agents in parallel** — each focused on a different review framework — then merges their findings into a single deduplicated review.

> **[Full documentation →](https://joeblackwaslike.github.io/ai-review-bot/)**

## How it works

1. Comment `/ai-review` on any pull request
2. The bot fetches the diff and PR metadata from GitHub
3. **Five review agents run in parallel**, each applying one focused framework to the diff:
   - **Bug detection** (`pr-review-toolkit:code-reviewer`) — project-standard compliance, ≥80% confidence threshold
   - **Error handling** (`pr-review-toolkit:silent-failure-hunter`) — swallowed exceptions, empty catch blocks, silent fallbacks
   - **Test coverage** (`pr-review-toolkit:pr-test-analyzer`) — gaps on critical paths, criticality scoring
   - **Security** (`security-scanning:security-sast`) — injection, path traversal, XSS, hardcoded secrets
   - **Multi-axis quality** (`addyosmani:code-review-and-quality`) — correctness, readability, architecture, performance
4. The **merge layer** deduplicates findings across agents (same `path:line` → one comment, more conservative finding wins), then emits a single verdict: `REQUEST_CHANGES` if any agent flagged a blocking issue, `COMMENT` otherwise
5. Every inline comment anchor is validated against the actual diff before submission; invalid anchors are silently dropped rather than erroring the whole review
6. The structured review is posted to GitHub with inline comments, general findings, and a summary

## Architecture

```
webhook → buildReview()
              │
              ├── runAgent(code-reviewer)       ┐
              ├── runAgent(silent-failure-hunter)│  Promise.allSettled()
              ├── runAgent(pr-test-analyzer)     │  (5 parallel API calls)
              ├── runAgent(security-sast)        │
              └── runAgent(code-review-and-quality) ┘
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

Each agent call uses prompt caching (`cache_control: ephemeral`) on its system prompt so repeated reviews of the same repo share a cached prefix. `Promise.allSettled` means one flaky API call won't kill the whole review.

## Quick start

1. **Create a GitHub App** with these permissions:
   - Pull requests: Read & write
   - Contents: Read-only
   - Issues: Read-only (for PR comments)
   - Subscribe to: `pull_request` and `issue_comment` events

2. **Fork and deploy to Vercel**:
   ```bash
   git clone https://github.com/joeblackwaslike/ai-review-bot.git
   cd ai-review-bot
   vercel link
   vercel env add GITHUB_APP_ID
   vercel env add GITHUB_APP_PRIVATE_KEY
   vercel env add GITHUB_WEBHOOK_SECRET
   vercel env add ANTHROPIC_API_KEY
   vercel env add REVIEW_ENABLED   # set to "true"
   vercel --prod
   ```

3. **Set your GitHub App's Webhook URL** to `https://your-deployment.vercel.app/api/github/webhook`

4. **Install the app** on the repos you want reviewed

5. **Comment `/ai-review` on any PR**

### Private key formatting

Vercel stores secrets as single-line strings. Convert your PEM to a one-liner before adding it:

```bash
awk 'NF {printf "%s\\n", $0}' your-private-key.pem
```

The bot normalizes `\n` back to newlines at runtime.

## Commands

```text
/ai-review                               # standard review
/ai-review focus on security             # with extra instructions
/ai-review --force                       # re-review same commit
/ai-review --force check for regressions # force + extra instructions
```

Only comments from `OWNER`, `MEMBER`, and `COLLABORATOR` author associations trigger a review. Draft PRs are skipped automatically. Reviews are idempotent — the bot won't re-review the same commit SHA unless you pass `--force`.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | ✓ | — | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | ✓ | — | RSA private key PEM (use `\n` for newlines) |
| `GITHUB_WEBHOOK_SECRET` | ✓ | — | HMAC secret for webhook signature verification |
| `ANTHROPIC_API_KEY` | ✓ | — | Anthropic API key |
| `REVIEW_ENABLED` | ✓ | `false` | Set to `true` to enable review submission |
| `ANTHROPIC_MODEL` | — | `claude-sonnet-4-6` | Model for all agents. Use `claude-opus-4-7` for higher-stakes repos. |
| `REVIEW_COMMAND` | — | `/ai-review` | Slash command that triggers reviews |
| `REVIEW_COMMENT_PREFIX` | — | `ai-review-bot` | Heading in the posted review body |
| `CUSTOM_REVIEW_PROMPT` | — | `Focus on correctness, security...` | Appended to every agent's system prompt |

See [`.env.example`](.env.example) for a ready-to-copy template.

## Development

```bash
npm install
npm run dev          # vercel dev (local server on :3000)
npm run typecheck    # tsc --noEmit
npm run lint         # biome check
npm run test         # vitest run
```

### Local webhook testing

GitHub can't reach localhost directly. Use [smee.io](https://smee.io) to proxy webhooks:

```bash
# Terminal 1 — webhook proxy
npx smee-client --url https://smee.io/<your-channel> \
  --target http://localhost:3000/api/github/webhook

# Terminal 2 — local server
npm run dev
```

Point your GitHub App's Webhook URL at the smee channel URL during development.

### Debug endpoint

`GET /api/debug` returns the current config state (keys are masked):

```json
{
  "reviewEnabled": "true",
  "reviewCommand": "/ai-review",
  "anthropicModel": "claude-sonnet-4-6",
  "hasAnthropicKey": true
}
```

## Project structure

```
api/
  github/webhook.ts    # webhook handler (signature verification, event routing)
  health.ts            # GET /api/health
  debug.ts             # GET /api/debug (config inspection)
src/
  anthropic.ts         # Anthropic client singleton
  config.ts            # environment variable parsing
  commands.ts          # slash command parsing, author association check
  github-app.ts        # Octokit setup, review submission + fallback retry
  prompt.ts            # buildUserMessage(), buildAgentSystemPrompt()
  review.ts            # agent layer, merge layer, diff anchor validation
  testing.ts           # test fixtures and builders
skills/
  code-reviewer.md                  # pr-review-toolkit:code-reviewer
  silent-failure-hunter.md          # pr-review-toolkit:silent-failure-hunter
  pr-test-analyzer.md               # pr-review-toolkit:pr-test-analyzer
  security-sast.md                  # security-scanning:security-sast
  code-review-and-quality.md        # addyosmani:code-review-and-quality
  code-review-excellence/SKILL.md   # base review mindset (shared context)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
