# Configuration

All configuration is via environment variables. Set them in Vercel's dashboard or with `vercel env add`.

## Required variables

| Variable | Description |
| --- | --- |
| `GITHUB_APP_ID` | Numeric GitHub App ID (shown in app settings) |
| `GITHUB_APP_PRIVATE_KEY` | RSA private key PEM with literal `\n` for newlines (see [formatting](#private-key-formatting)) |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for webhook signature verification |
| `ANTHROPIC_API_KEY` | Anthropic API key (starts with `sk-ant-`) |
| `REVIEW_ENABLED` | Must be `true` to post reviews. Any other value (including absent) disables posting. |

## Optional variables

| Variable | Default | Description |
| --- | --- | --- |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model used by all five agents. Use `claude-opus-4-7` for higher-stakes repos where review quality matters more than cost. |
| `REVIEW_COMMAND` | `/ai-review` | Slash command that triggers a review. Change if you want a different command name. |
| `REVIEW_COMMENT_PREFIX` | `ai-review-bot` | Heading in the posted review body (renders as `### ai-review-bot`). |
| `CUSTOM_REVIEW_PROMPT` | `Focus on correctness, security, regressions, and missing tests.` | Appended to every agent's system prompt. Use this to add repo-specific instructions (e.g. "This codebase uses snake_case for all Python identifiers."). |

## Private key formatting

GitHub generates PEM private keys with literal newlines. Vercel env vars are single-line strings, so you need to convert the newlines to `\n` escape sequences before storing:

```bash
awk 'NF {printf "%s\\n", $0}' your-private-key.pem
```

The bot normalizes `\n` back to actual newlines at startup via `normalizePrivateKey()` in `src/config.ts`. The stored string should look like:

```
-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----
```

## Model selection

The default model (`claude-sonnet-4-6`) balances cost and quality well for most PRs. For repos where review depth is critical — security-sensitive code, complex business logic, large diffs — override to `claude-opus-4-7`:

```env
ANTHROPIC_MODEL=claude-opus-4-7
```

Keep in mind that five agents run per review, so token costs are multiplied by five. With Sonnet the cost per review is typically $0.05–$0.30 depending on diff size. With Opus it's $0.25–$1.50.

## Custom review prompt

The `CUSTOM_REVIEW_PROMPT` is injected into every agent's system prompt under `## Custom Instructions`. Use it for:

- Repo-specific coding standards ("Always use our internal logger, not console.log")
- Language-specific rules ("This is a Python 3.12 codebase — flag any use of Optional or Union")
- Domain-specific security concerns ("Flag any query that touches the payments table without explicit row-level security")
- Tone preferences ("Be terse. Skip findings with < 90% confidence.")

## Verifying your setup

After deployment, two diagnostic endpoints are available:

### `GET /api/health`

Returns `200 OK` with `{ "status": "ok" }`. Use this as your uptime check.

### `GET /api/debug`

Returns the current config state. API keys are masked — you can see whether they're set but not their values:

```json
{
  "reviewEnabled": "true",
  "reviewEnabledBool": true,
  "reviewCommand": "/ai-review",
  "anthropicModel": "claude-sonnet-4-6",
  "hasAppId": true,
  "hasPrivateKey": true,
  "hasWebhookSecret": true,
  "hasAnthropicKey": true
}
```

If any `has*` field is `false`, that variable is missing and reviews will fail.

## Environment variable template

Copy `.env.example` from the repo for a ready-to-fill template:

```env
# GitHub App credentials
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=

GITHUB_WEBHOOK_SECRET=

# Anthropic
ANTHROPIC_API_KEY=

# Review behavior
REVIEW_ENABLED=true
# Default: claude-sonnet-4-6. Override with claude-opus-4-7 for high-stakes repos.
ANTHROPIC_MODEL=claude-sonnet-4-6
REVIEW_COMMAND=/ai-review
REVIEW_COMMENT_PREFIX=ai-review-bot
CUSTOM_REVIEW_PROMPT=
```
