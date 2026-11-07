# Configuration

Behavior settings live in `.ai-review.yaml`. Credentials and infra secrets are environment-only. Set environment variables in Vercel's dashboard or with `vercel env add`.

`pnpm config:check` validates the YAML with the current environment, and `pnpm docs:config` regenerates the reference at the bottom of this page. Both run through Bun (version in `.bun-version`), so install Bun first.

## Claude bot credentials

| Variable | Required | Description |
| --- | --- | --- |
| `AI_REVIEW_REVIEWERS__CLAUDE__APP_ID` | ✓ | Numeric GitHub App ID for the Claude bot (shown in app settings). Alias: `GITHUB_APP_ID` (permanent) |
| `AI_REVIEW_REVIEWERS__CLAUDE__PRIVATE_KEY` | ✓ | PKCS#8 private key PEM with literal `\n` for newlines (see [formatting](#private-key-formatting)). Alias: `GITHUB_APP_PRIVATE_KEY` (permanent) |
| `AI_REVIEW_REVIEWERS__CLAUDE__WEBHOOK_SECRET` | ✓ | HMAC secret for webhook signature verification. Alias: `GITHUB_WEBHOOK_SECRET` (deprecated) |
| `AI_REVIEW_PROVIDERS__ANTHROPIC__API_KEY` | ✓ | Anthropic API key (starts with `sk-ant-`). Alias: `ANTHROPIC_API_KEY` (permanent) |

The Claude bot webhook is at `/api/github/webhook`, and also at `/api/github/reviewer/claude`.

## Codex bot credentials

| Variable | Required | Description |
| --- | --- | --- |
| `AI_REVIEW_REVIEWERS__CODEX__APP_ID` | ✓ | Numeric GitHub App ID for the Codex bot. Alias: `OPENAI_APP_ID` (deprecated) |
| `AI_REVIEW_REVIEWERS__CODEX__PRIVATE_KEY` | ✓ | PKCS#8 private key PEM with literal `\n` for newlines. Alias: `OPENAI_APP_PRIVATE_KEY` (deprecated) |
| `AI_REVIEW_REVIEWERS__CODEX__WEBHOOK_SECRET` | ✓ | HMAC secret for the Codex bot webhook. Alias: `OPENAI_APP_WEBHOOK_SECRET` (deprecated) |
| `AI_REVIEW_PROVIDERS__OPENAI__API_KEY` | ✓ | OpenAI API key (starts with `sk-`). Alias: `OPENAI_API_KEY` (permanent) |

The Codex bot webhook is at `/api/github/webhook-openai`, and also at `/api/github/reviewer/codex`. Deprecated aliases still work and log a warning. To add another reviewer, see [Adding a reviewer](adding-a-reviewer.md).

## Shared behavior

These settings apply to both bots. Set them in `.ai-review.yaml` or with the env vars below. The old names (`REVIEW_ENABLED`, `REVIEW_COMMAND`, `REVIEW_DELAY_SECONDS`, `REVIEW_RESYNC_DELAY_SECONDS`, `CUSTOM_REVIEW_PROMPT`) still work as deprecated aliases and log a warning.

| Variable | Default | Description |
| --- | --- | --- |
| `AI_REVIEW_REVIEW__ENABLED` | `true` | Set to `false` to disable automatic reviews on PR open/push. Slash-command reviews still work. |
| `AI_REVIEW_REVIEW__COMMAND` | `/ai-review` | Slash command that triggers a review from either bot. |
| `AI_REVIEW_REVIEW__DELAY_SECONDS` | `0` | Seconds to wait before auto-review fires on PR open. Default is to start immediately. |
| `AI_REVIEW_REVIEW__RESYNC_DELAY_SECONDS` | `0` | Seconds to wait before re-reviewing after a push. Default is to start immediately. |
| `AI_REVIEW_REVIEW__CUSTOM_PROMPT` | unset | Extra instructions appended to every agent's system prompt for both bots. |

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

Tier thresholds, path patterns and the model and effort chosen for each tier are defined in [.ai-review.yaml](https://github.com/joeblackwaslike/ai-review-bot/blob/main/.ai-review.yaml). Edit that file rather than a copy of it here.

### Model prices

Cost figures come from the [OpenRouter models API](https://openrouter.ai/api/v1/models), cached for 24 hours rather than fetched per review (a daily cron refreshes the shared cache in KV; the CLI caches in `~/.ai-review/pricing.json`). The shared cache needs KV. Without KV, each cold hosted instance fetches once, with a 3 second timeout, and retries a failed fetch no sooner than every 5 minutes. Ids match after lowercasing and mapping `.` to `-`, so `claude-sonnet-5.5` and `claude-sonnet-5-5` are the same model. Prompts above a model's override threshold bill at the higher rate. A `models.<provider/model>.pricing` entry in the YAML pins a price and wins over OpenRouter. A model with neither shows "cost unavailable" in the review footer, and `replay --live` refuses to run because it cannot enforce `--max-cost`.

To force the deep tier on a PR without a label, add `deep-review` to the PR labels before triggering the review.

## Custom review prompt

`review.customPrompt` (`AI_REVIEW_REVIEW__CUSTOM_PROMPT`) is injected into every agent's system prompt under `## Custom Instructions`. Both bots use the same value. Use it for:

- Repo-specific coding standards (`"Always use our internal logger, not console.log"`)
- Language-specific rules (`"This is a Python 3.12 codebase — flag any use of Optional or Union"`)
- Domain-specific security concerns (`"Flag any query that touches the payments table without explicit row-level security"`)
- Tone preferences (`"Be terse. Skip findings with < 90% confidence."`)

## Behavior changes from the old env parsing

The aliased env vars (`REVIEW_ENABLED`, `AGENT_CONCURRENCY` and the rest) now go through the config loader, which is stricter than the old code:

- A malformed boolean or number fails at config load instead of falling back to a default. Examples: `REVIEW_ENABLED=0`, `AGENT_CONCURRENCY=0`, `REVIEW_AGENT_BUDGET_SECONDS=abc`.
- Booleans are case-insensitive `true` or `false`, so `REVIEW_ENABLED=FALSE` now disables review.
- A blank env value counts as unset, so the value from `.ai-review.yaml` (or the schema default) applies. With the shipped YAML, `CUSTOM_REVIEW_PROMPT=""` uses the default prompt text and `REVIEW_COMMAND=""` uses `/ai-review`.
- Decimal delays and fractional concurrency still work. Concurrency is floored.
- `PUBLIC_URL` and `QSTASH_URL` are plain strings.
- Any unknown `AI_REVIEW_*` variable is a hard startup error.
- Each deprecated alias logs one warning per cold start that names its replacement. For `PUBLIC_URL` and `QSTASH_URL` the replacements are `AI_REVIEW_INFRA__PUBLIC_URL` and `AI_REVIEW_INFRA__QSTASH_URL`.

## Live overrides (Edge Config)

Edge Config changes a few settings in seconds, with no redeploy. Typical use is turning off one reviewer, or all review, during an incident.

- Set `EDGE_CONFIG` to your Vercel Edge Config connection string. Without it, nothing changes. The package is `@vercel/global-config`, the renamed `@vercel/edge-config` with the same API.
- Store a flat JSON map. Each key is a derived env name, for example `AI_REVIEW_REVIEWERS__GEMINI__ENABLED`, with a JSON value.
- Only settings marked Live in the reference below apply. A typo or a non-live key is ignored, and `/api/debug` lists it under `edge.ignored` with a reason.
- Precedence is Edge Config, then env, then YAML.
- Edge Config can disable a reviewer. It cannot enable one that YAML disables, and it cannot ready one whose secrets are missing: that reviewer still returns 503.
- If the read fails or takes longer than 2 seconds, the bot uses the cold config and `/api/debug` shows `edge.error`. Reads are cached for 5 seconds.

## Verifying your setup

Two diagnostic endpoints are available after deployment:

### `GET /api/health`

Returns `200 OK` with `{ "status": "ok" }`. Use this as your uptime check.

### `GET /api/debug`

Requires the cron secret. Call it with `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/debug`. With the right bearer secret it returns the resolved config and which credentials are present. API keys are never returned, and `review.customPrompt` and every `cli.*` and `infra.*` value are shown as `[set]` when set:

```json
{
  "config": [
    { "path": "review.enabled", "value": true, "source": "yaml" },
    { "path": "review.command", "value": "/ai-review", "source": "yaml" },
    { "path": "review.customPrompt", "value": "[set]", "source": "env" }
  ],
  "warnings": [],
  "reviewEnabled": true,
  "reviewCommand": "/ai-review",
  "hasAnthropicKey": true,
  "hasAppId": true,
  "hasPrivateKey": true,
  "hasWebhookSecret": true,
  "hasOpenAIKey": true,
  "hasOpenAIAppId": true,
  "hasOpenAIPrivateKey": true,
  "hasOpenAIWebhookSecret": true
}
```

`config` lists each resolved setting that has a value (unset optional settings are omitted) with its source (`env`, `alias`, `yaml` or `default`). If the config fails to load, the response is `{ "configError": "<message>", ...has* fields }` instead.

A request without the right bearer secret, or any request when `CRON_SECRET` is unset or empty, gets only `reviewEnabled`, `reviewCommand` and the `has*` fields. It never gets `config`, `warnings` or `configError`. If the config fails to load, it gets only the `has*` fields.

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
# AI_REVIEW_REVIEW__ENABLED=true
# AI_REVIEW_REVIEW__COMMAND=/ai-review
# AI_REVIEW_REVIEW__DELAY_SECONDS=0
# AI_REVIEW_REVIEW__CUSTOM_PROMPT=
```

<!-- config-reference:start -->
## Config reference

Generated by `pnpm docs:config` from `src/config/schema.ts`. Do not edit by hand.

Values come from `.ai-review.yaml`. Any supported scalar leaf can be overridden by an environment variable named `AI_REVIEW_` plus the path in upper snake case, with `__` between segments (`review.delaySeconds` becomes `AI_REVIEW_REVIEW__DELAY_SECONDS`). A deprecated alias works but logs a warning; when both are set the derived name wins. An unknown `AI_REVIEW_*` variable is a hard error.

Env overrides apply to every section. Dynamic map entries must already exist in the YAML before an env var can set them: `reviewers.<id>`, `reviewers.<id>.skills.<skill>` and `providers.<provider>`. `version` and everything under `models` have no env var. Array leaves take a JSON value. In `<ID>`, `<SKILL>` and `<PROVIDER>`, hyphens become underscores.

Rows marked Live can also be overridden at runtime through Edge Config (`EDGE_CONFIG`, package `@vercel/global-config`) using the same env names as keys, with no redeploy. Edge Config can disable but cannot enable, so an Edge `true` over a disabled `review.enabled`, `reviewers.<id>.enabled` or `roles.verifier.enabled` is ignored and listed under `edge.ignored` in `/api/debug`. When an Edge read fails, the last good overrides stay in effect; the cold config is used only before the first good read.

| YAML path | Env var | Alias | Type | Default | Live | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `version` | none | none | literal | required |  | Config schema version. |
| `review.enabled` | `AI_REVIEW_REVIEW__ENABLED` | `REVIEW_ENABLED` (deprecated) | boolean | `true` | yes | Review pull requests automatically. |
| `review.delaySeconds` | `AI_REVIEW_REVIEW__DELAY_SECONDS` | `REVIEW_DELAY_SECONDS` (deprecated) | number | `0` | yes | Delay before the first automatic review. |
| `review.resyncDelaySeconds` | `AI_REVIEW_REVIEW__RESYNC_DELAY_SECONDS` | `REVIEW_RESYNC_DELAY_SECONDS` (deprecated) | number | `0` | yes | Delay before re-reviewing after a push. |
| `review.command` | `AI_REVIEW_REVIEW__COMMAND` | `REVIEW_COMMAND` (deprecated) | string | `"/ai-review"` |  | Comment command that triggers a review. |
| `review.customPrompt` | `AI_REVIEW_REVIEW__CUSTOM_PROMPT` | `CUSTOM_REVIEW_PROMPT` (deprecated) | string | unset |  | Extra instructions appended to every agent prompt. |
| `review.minSeverity` | `AI_REVIEW_REVIEW__MIN_SEVERITY` | none | one of P3, P2, P1 | `"P3"` |  | Findings below this floor are dropped. P0 and P1 are never dropped by the floor; P1 drops P2 and P3. |
| `review.agentConcurrency` | `AI_REVIEW_REVIEW__AGENT_CONCURRENCY` | `AGENT_CONCURRENCY` (deprecated) | number | `4` | yes | Maximum review agents run in parallel per PR. |
| `review.agentBudgetSeconds` | `AI_REVIEW_REVIEW__AGENT_BUDGET_SECONDS` | `REVIEW_AGENT_BUDGET_SECONDS` (deprecated) | number | `210` | yes | Wall-clock deadline for agents, in seconds. |
| `review.diffBudgetChars` | `AI_REVIEW_REVIEW__DIFF_BUDGET_CHARS` | `REVIEW_DIFF_BUDGET_CHARS` (deprecated) | number | `200000` | yes | PR-wide character budget for the serialized diff. |
| `review.tier2Enabled` | `AI_REVIEW_REVIEW__TIER2_ENABLED` | `REVIEW_TIER2_ENABLED` (deprecated) | boolean | `true` | yes | Run conditional Tier 2 review skills. |
| `review.feedbackEnabled` | `AI_REVIEW_REVIEW__FEEDBACK_ENABLED` | `FEEDBACK_ENABLED` (deprecated) | boolean | `false` |  | Record reaction feedback on findings. |
| `improve.enabled` | `AI_REVIEW_IMPROVE__ENABLED` | `IMPROVE_ENABLED` (deprecated) | boolean | `false` |  | Capture the improvement corpus. |
| `improve.carrierEnabled` | `AI_REVIEW_IMPROVE__CARRIER_ENABLED` | `IMPROVE_CARRIER_ENABLED` (deprecated) | boolean | `false` |  | Post the review summary carrier comment. |
| `infra.publicUrl` | `AI_REVIEW_INFRA__PUBLIC_URL` | `PUBLIC_URL` (deprecated) | string | unset |  | Stable public origin used for QStash callbacks. |
| `infra.qstashUrl` | `AI_REVIEW_INFRA__QSTASH_URL` | `QSTASH_URL` (deprecated) | string | unset |  | QStash regional endpoint. |
| `cli.gateDir` | `AI_REVIEW_CLI__GATE_DIR` | `AI_REVIEW_GATE_DIR` (permanent) | string | unset |  | Directory for the gate store. |
| `cli.mistakesDir` | `AI_REVIEW_CLI__MISTAKES_DIR` | `AI_REVIEW_MISTAKES_DIR` (permanent) | string | unset |  | Directory for the mistake log. |
| `cli.logFile` | `AI_REVIEW_CLI__LOG_FILE` | `AI_REVIEW_LOG_FILE` (permanent) | string | unset |  | Path of the agent outcome log. |
| `routing.sensitivePathPatterns` | `AI_REVIEW_ROUTING__SENSITIVE_PATH_PATTERNS` | none | string[] | `["auth","crypto","jwt","password","secret","/db/","database","migration","schema"]` |  | Path substrings (case-insensitive) that force the complex tier. |
| `routing.docExtensions` | `AI_REVIEW_ROUTING__DOC_EXTENSIONS` | none | string[] | `[".md",".txt",".rst",".mdx"]` |  | File extensions treated as documentation. |
| `routing.deepLabel` | `AI_REVIEW_ROUTING__DEEP_LABEL` | none | string | `"deep-review"` |  | PR label that forces the deep tier. |
| `routing.complexLines` | `AI_REVIEW_ROUTING__COMPLEX_LINES` | none | number | `500` |  | Changed lines above which a PR is complex. |
| `routing.trivialDocLines` | `AI_REVIEW_ROUTING__TRIVIAL_DOC_LINES` | none | number | `20` |  | Changed lines below which a docs-only PR is trivial. |
| `models.<provider/model>.pricing.input` | none | none | number | unset |  | Input token price, USD per million tokens. |
| `models.<provider/model>.pricing.cachedInput` | none | none | number | unset |  | Cached input token price, USD per million tokens. |
| `models.<provider/model>.pricing.output` | none | none | number | unset |  | Output token price, USD per million tokens. |
| `models.<provider/model>.refusalFallback` | none | none | boolean | `false` |  | Retry once with a fallback when the model refuses. |
| `models.<provider/model>.effortControl` | none | none | one of level, budget | unset |  | How a Google model takes reasoning effort. |
| `models.<provider/model>.providerOptions.<provider>` | none | none | object | unset |  | Options for one provider. |
| `models.<provider/model>.structuredOutput` | none | none | one of native, json | `"native"` |  | Reserved. Not read yet; a later slice will use it to pick the structured output mode. |
| `reviewers.<id>.enabled` | `AI_REVIEW_REVIEWERS__<ID>__ENABLED` | none | boolean | `true` | yes | Run this reviewer. |
| `reviewers.<id>.appId` | `AI_REVIEW_REVIEWERS__<ID>__APP_ID` | none | string | unset |  | GitHub App id; the environment supplies it when unset. |
| `reviewers.<id>.appSlug` | `AI_REVIEW_REVIEWERS__<ID>__APP_SLUG` | none | string | unset |  | GitHub App slug, used to recognize this bot's own reviews. |
| `reviewers.<id>.commentPrefix` | `AI_REVIEW_REVIEWERS__<ID>__COMMENT_PREFIX` | none | string | unset |  | Heading prefix on this reviewer's comments. |
| `reviewers.<id>.concurrency` | `AI_REVIEW_REVIEWERS__<ID>__CONCURRENCY` | none | number | unset | yes | Maximum agents run in parallel for this reviewer. |
| `reviewers.<id>.runOn` | `AI_REVIEW_REVIEWERS__<ID>__RUN_ON` | none | one of trivial, normal, complex, deep[] | unset |  | Tiers this reviewer runs on; every tier when unset. |
| `reviewers.<id>.roles.summary.model` | `AI_REVIEW_REVIEWERS__<ID>__ROLES__SUMMARY__MODEL` | none | string | unset |  | Model for this role. |
| `reviewers.<id>.roles.summary.effort` | `AI_REVIEW_REVIEWERS__<ID>__ROLES__SUMMARY__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.roles.triage.model` | `AI_REVIEW_REVIEWERS__<ID>__ROLES__TRIAGE__MODEL` | none | string | unset |  | Model for this role. |
| `reviewers.<id>.roles.triage.effort` | `AI_REVIEW_REVIEWERS__<ID>__ROLES__TRIAGE__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.roles.revalidate.model` | `AI_REVIEW_REVIEWERS__<ID>__ROLES__REVALIDATE__MODEL` | none | string | unset |  | Model for this role. |
| `reviewers.<id>.roles.revalidate.effort` | `AI_REVIEW_REVIEWERS__<ID>__ROLES__REVALIDATE__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.skills.<skill>.model` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__MODEL` | none | string | unset |  | Model for this skill in every tier. |
| `reviewers.<id>.skills.<skill>.effort` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Effort for the skill model; needs model. |
| `reviewers.<id>.skills.<skill>.trivial.model` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__TRIVIAL__MODEL` | none | string | unset |  | Model for this tier. |
| `reviewers.<id>.skills.<skill>.trivial.effort` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__TRIVIAL__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.skills.<skill>.normal.model` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__NORMAL__MODEL` | none | string | unset |  | Model for this tier. |
| `reviewers.<id>.skills.<skill>.normal.effort` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__NORMAL__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.skills.<skill>.complex.model` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__COMPLEX__MODEL` | none | string | unset |  | Model for this tier. |
| `reviewers.<id>.skills.<skill>.complex.effort` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__COMPLEX__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.skills.<skill>.deep.model` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__DEEP__MODEL` | none | string | unset |  | Model for this tier. |
| `reviewers.<id>.skills.<skill>.deep.effort` | `AI_REVIEW_REVIEWERS__<ID>__SKILLS__<SKILL>__DEEP__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.tiers.trivial.model` | `AI_REVIEW_REVIEWERS__<ID>__TIERS__TRIVIAL__MODEL` | none | string | required |  | Model for this tier. |
| `reviewers.<id>.tiers.trivial.effort` | `AI_REVIEW_REVIEWERS__<ID>__TIERS__TRIVIAL__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.tiers.normal.model` | `AI_REVIEW_REVIEWERS__<ID>__TIERS__NORMAL__MODEL` | none | string | required |  | Model for this tier. |
| `reviewers.<id>.tiers.normal.effort` | `AI_REVIEW_REVIEWERS__<ID>__TIERS__NORMAL__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.tiers.complex.model` | `AI_REVIEW_REVIEWERS__<ID>__TIERS__COMPLEX__MODEL` | none | string | required |  | Model for this tier. |
| `reviewers.<id>.tiers.complex.effort` | `AI_REVIEW_REVIEWERS__<ID>__TIERS__COMPLEX__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `reviewers.<id>.tiers.deep.model` | `AI_REVIEW_REVIEWERS__<ID>__TIERS__DEEP__MODEL` | none | string | required |  | Model for this tier. |
| `reviewers.<id>.tiers.deep.effort` | `AI_REVIEW_REVIEWERS__<ID>__TIERS__DEEP__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `roles.summary.model` | `AI_REVIEW_ROLES__SUMMARY__MODEL` | none | string | unset |  | Model for this role. |
| `roles.summary.effort` | `AI_REVIEW_ROLES__SUMMARY__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `roles.triage.model` | `AI_REVIEW_ROLES__TRIAGE__MODEL` | none | string | unset |  | Model for this role. |
| `roles.triage.effort` | `AI_REVIEW_ROLES__TRIAGE__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `roles.revalidate.model` | `AI_REVIEW_ROLES__REVALIDATE__MODEL` | none | string | unset |  | Model for this role. |
| `roles.revalidate.effort` | `AI_REVIEW_ROLES__REVALIDATE__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `roles.verifier.model` | `AI_REVIEW_ROLES__VERIFIER__MODEL` | none | string | unset |  | Model for this role. |
| `roles.verifier.effort` | `AI_REVIEW_ROLES__VERIFIER__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `roles.verifier.differentFrom` | none | none | literal | unset |  | Require the verifier to use a different provider than the finder. |
| `roles.verifier.enabled` | `AI_REVIEW_ROLES__VERIFIER__ENABLED` | none | boolean | `true` | yes | Run the verifier. |
| `roles.qcJudge.model` | `AI_REVIEW_ROLES__QC_JUDGE__MODEL` | none | string | unset |  | Model for this role. |
| `roles.qcJudge.effort` | `AI_REVIEW_ROLES__QC_JUDGE__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `roles.classifier.model` | `AI_REVIEW_ROLES__CLASSIFIER__MODEL` | none | string | unset |  | Model for this role. |
| `roles.classifier.effort` | `AI_REVIEW_ROLES__CLASSIFIER__EFFORT` | none | one of none, low, medium, high, xhigh, max | unset |  | Reasoning effort passed to the provider. |
| `providers.<provider>.baseURL` | `AI_REVIEW_PROVIDERS__<PROVIDER>__BASE_URL` | none | string | unset |  | Override the provider API base URL. |

### Secrets

Secrets are never part of the config tree. Each is read from the env var below, or from a standard name. When both are set the env var named `AI_REVIEW_` plus the path wins. Only `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and the standard provider key names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) are permanent aliases. Every other standard name, including `GITHUB_WEBHOOK_SECRET`, is deprecated and logs a warning. Any other reviewer uses `AI_REVIEW_REVIEWERS__<ID>__PRIVATE_KEY` and `AI_REVIEW_REVIEWERS__<ID>__WEBHOOK_SECRET`; a name for a reviewer that is not in the YAML is ignored with a warning.

| Env var | Standard name | Permanence |
| --- | --- | --- |
| `AI_REVIEW_REVIEWERS__CLAUDE__PRIVATE_KEY` | `GITHUB_APP_PRIVATE_KEY` | permanent |
| `AI_REVIEW_REVIEWERS__CLAUDE__WEBHOOK_SECRET` | `GITHUB_WEBHOOK_SECRET` | deprecated |
| `AI_REVIEW_REVIEWERS__CODEX__PRIVATE_KEY` | `OPENAI_APP_PRIVATE_KEY` | deprecated |
| `AI_REVIEW_REVIEWERS__CODEX__WEBHOOK_SECRET` | `OPENAI_APP_WEBHOOK_SECRET` | deprecated |
| `AI_REVIEW_PROVIDERS__ANTHROPIC__API_KEY` | `ANTHROPIC_API_KEY` | permanent |
| `AI_REVIEW_PROVIDERS__OPENAI__API_KEY` | `OPENAI_API_KEY` | permanent |
| `AI_REVIEW_PROVIDERS__GOOGLE__API_KEY` | `GOOGLE_GENERATIVE_AI_API_KEY` | permanent |
| `AI_REVIEW_GITHUB__WEBHOOK_SECRET` | none | - |

<!-- config-reference:end -->
