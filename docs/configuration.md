# Configuration

All configuration is via environment variables. Set them in Vercel's dashboard or with `vercel env add`.

## Claude bot credentials

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_APP_ID` | ✓ | Numeric GitHub App ID for the Claude bot (shown in app settings) |
| `GITHUB_APP_PRIVATE_KEY` | ✓ | PKCS#8 private key PEM with literal `\n` for newlines (see [formatting](#private-key-formatting)) |
| `GITHUB_WEBHOOK_SECRET` | ✓ | HMAC secret for webhook signature verification |
| `ANTHROPIC_API_KEY` | ✓ | Anthropic API key (starts with `sk-ant-`) |

The Claude bot webhook is at `/api/github/webhook`.

## Codex bot credentials

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_APP_ID` | ✓ | Numeric GitHub App ID for the Codex bot |
| `OPENAI_APP_PRIVATE_KEY` | ✓ | PKCS#8 private key PEM with literal `\n` for newlines |
| `OPENAI_APP_WEBHOOK_SECRET` | ✓ | HMAC secret for the Codex bot webhook |
| `OPENAI_API_KEY` | ✓ | OpenAI API key (starts with `sk-`) |

The Codex bot webhook is at `/api/github/webhook-openai`.

## Shared behavior

These variables apply to both bots:

| Variable | Default | Description |
| --- | --- | --- |
| `REVIEW_ENABLED` | `true` | Set to `false` to disable automatic reviews on PR open/push. Slash-command reviews still work. |
| `REVIEW_COMMAND` | `/ai-review` | Slash command that triggers a review from either bot. |
| `REVIEW_DELAY_SECONDS` | `450` | Seconds to wait before auto-review fires on PR open (7.5 min). Gives CI time to run first. |
| `CUSTOM_REVIEW_PROMPT` | — | Extra instructions appended to every agent's system prompt for both bots. |

## Private key formatting

GitHub generates PEM private keys with literal newlines. Vercel env vars are single-line strings, so convert newlines to `\n` escape sequences before storing:

```bash
awk 'NF {printf "%s\\n", $0}' your-private-key.pem
```

The bot normalizes `\n` back to actual newlines at startup. The stored string looks like:

```text
-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END PRIVATE KEY-----
```

> **PKCS#8 required.** If your key header reads `BEGIN RSA PRIVATE KEY` (PKCS#1), convert it first:
>
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key.pkcs8.pem
> ```

## Model routing

Neither bot uses a fixed model. The router (`src/router.ts`) classifies each PR into one of four tiers based on the diff, file paths, and labels, then selects the appropriate model automatically.

### Tier classification

| Tier | Conditions |
| --- | --- |
| `trivial` | All changed files are docs (`.md`, `.txt`, etc.) and total diff < 20 lines |
| `normal` | Everything else |
| `complex` | Diff > 500 lines, **or** any changed path contains `auth`, `crypto`, `jwt`, `password`, `secret`, `/db/`, `database`, `migration`, or `schema` |
| `deep` | PR has the `deep-review` label |

### Model selection per tier

| Tier | Claude bot | Codex bot |
| --- | --- | --- |
| `trivial` | `claude-haiku-4-5` | `gpt-5` |
| `normal` | `claude-sonnet-4-6` | `gpt-5` |
| `complex` | `claude-sonnet-4-6` + 8K thinking budget | `o4-mini` reasoning medium |
| `deep` | `claude-opus-4-7` + 16K thinking budget | `o3` reasoning high |

To force the deep tier on a PR without a label, add `deep-review` to the PR labels before triggering the review.

## Custom review prompt

`CUSTOM_REVIEW_PROMPT` is injected into every agent's system prompt under `## Custom Instructions`. Both bots use the same value. Use it for:

- Repo-specific coding standards (`"Always use our internal logger, not console.log"`)
- Language-specific rules (`"This is a Python 3.12 codebase — flag any use of Optional or Union"`)
- Domain-specific security concerns (`"Flag any query that touches the payments table without explicit row-level security"`)
- Tone preferences (`"Be terse. Skip findings with < 90% confidence."`)

## Verifying your setup

Two diagnostic endpoints are available after deployment:

### `GET /api/health`

Returns `200 OK` with `{ "status": "ok" }`. Use this as your uptime check.

### `GET /api/debug`

Returns the current config state. API keys are masked:

```json
{
  "reviewEnabled": "true",
  "reviewCommand": "/ai-review",
  "hasAnthropicKey": true,
  "hasOpenAIKey": true,
  "hasAppId": true,
  "hasPrivateKey": true,
  "hasWebhookSecret": true,
  "hasOpenAIAppId": true,
  "hasOpenAIPrivateKey": true,
  "hasOpenAIWebhookSecret": true
}
```

If any `has*` field is `false`, that variable is missing.

## Environment variable template

Copy `.env.example` from the repo:

```env
# Claude bot credentials
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
ANTHROPIC_API_KEY=

# Codex bot credentials
OPENAI_APP_ID=
OPENAI_APP_PRIVATE_KEY=
OPENAI_APP_WEBHOOK_SECRET=
OPENAI_API_KEY=

# Shared behavior (all optional — defaults shown)
# REVIEW_ENABLED=true
# REVIEW_COMMAND=/ai-review
# REVIEW_DELAY_SECONDS=450
# CUSTOM_REVIEW_PROMPT=
```
