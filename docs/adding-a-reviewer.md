# Adding a reviewer

A reviewer is one bot identity: its own GitHub App, its own comment heading, and its own model for each PR size. Claude and Codex ship enabled. Gemini ships in `.ai-review.yaml` with `enabled: false`. This page walks through adding another one, using `gemini` as the example id.

Only a human can do three steps: create the GitHub App, install it on repos, and set environment variables in Vercel. Everything else happens in the repo.

## 1. Add the YAML entry

Add the reviewer under `reviewers` in `.ai-review.yaml`. The id must match `^[a-z][a-z0-9-]*$`, and `anthropic` and `openai` are reserved.

```yaml
reviewers:
  gemini:
    enabled: false
    appSlug: gemini-review-bot
    commentPrefix: gemini-review-bot
    tiers:
      trivial: { model: google/gemini-3.1-flash-lite, effort: low }
      normal: { model: google/gemini-3.1-flash-lite, effort: medium }
      complex: { model: google/gemini-3.8-flash, effort: medium }
      deep: { model: google/gemini-3.8-flash, effort: high }
```

- `appSlug` is the slug of the GitHub App you create in step 2. The bot uses it to recognize its own reviews and to tell its peers apart. Two reviewers cannot share a slug.
- `commentPrefix` is the heading each review starts with (`### gemini-review-bot`).
- `tiers` picks a model and a reasoning effort for each PR size. Every tier needs an entry. A model is written `provider/model`, and the provider must be one of `anthropic`, `openai` or `google`. The effort values a model accepts depend on its provider; `pnpm config:check` rejects one that is not supported.
- `skills` (optional) overrides the model for a single review skill. `runOn` (optional) limits the reviewer to some tiers.

Leave `enabled: false` until step 6.

Token prices come from OpenRouter and are cached for 24 hours. If a model shows "cost unavailable" in a review, pin its price under `models.<provider/model>.pricing` in the YAML.

## 2. Create the GitHub App (human step)

Create the app the same way as the Claude app in [Quick Start](quick-start.md), with these differences:

- Name the app so its slug equals `appSlug`.
- Set the webhook URL to `https://<your-domain>/api/github/reviewer/<id>`, for example `https://claude-review-bot.vercel.app/api/github/reviewer/gemini`.
- Pick a webhook secret. Give each reviewer its own (see "Limits today").
- Permissions: Pull requests read and write, Contents read-only, Metadata read-only, Issues read-only. Events: Pull request and Issue comment.
- Generate a private key and note the App ID.

Install the app on the repos it should review. That is also a person's step.

## 3. Set the environment variables (human step)

Set these in Vercel for the production environment, with `<ID>` as the reviewer id in upper case and hyphens turned into underscores.

| Variable | Value |
| --- | --- |
| `AI_REVIEW_REVIEWERS__<ID>__APP_ID` | The App ID |
| `AI_REVIEW_REVIEWERS__<ID>__PRIVATE_KEY` | The private key PEM, with literal `\n` for newlines |
| `AI_REVIEW_REVIEWERS__<ID>__WEBHOOK_SECRET` | The webhook secret from step 2 |
| The provider key | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`, depending on the models in the tiers |

For Gemini that is `AI_REVIEW_REVIEWERS__GEMINI__APP_ID`, `AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY`, `AI_REVIEW_REVIEWERS__GEMINI__WEBHOOK_SECRET` and `GOOGLE_GENERATIVE_AI_API_KEY`.

The reviewer is ready when the App ID, the private key, the webhook secret (its own, or the shared `AI_REVIEW_GITHUB__WEBHOOK_SECRET`) and the key for every provider it uses are all set. An `AI_REVIEW_REVIEWERS__<ID>__*` secret for an id that is not in the YAML is ignored with a warning.

Then check the configuration from a checkout:

```bash
pnpm config:check
```

It exits 1 on any error, and warns when a reviewer secret names an id that is not in the YAML.

## 4. Run a replay

The offline replay re-runs recorded review rounds. To use it for a new reviewer, record a PR the bot has reviewed:

```bash
ai-review replay --record <pr-url> --reviewer gemini --bot <bot-login>[bot]
```

Then run the live replay with a spending cap:

```bash
ai-review replay --live --reviewer gemini --max-cost 2
```

`--live` calls the models and costs real money, and it never gates CI. `--max-cost` is in USD and defaults to 5. The run needs a known price for each model, so pin one in the YAML if OpenRouter does not list it. Check the false-positive rate and the cost in the output before you enable the reviewer.

Gemini's structured output was checked only against a mocked request. The first live run sends the review schema to the real Google API, so that run is the real test of whether Gemini accepts it.

## 5. Turn it on

Set `enabled: true` in `.ai-review.yaml`, commit, and deploy. While `enabled` is false the route answers 503 and lists `reviewers.<id>.enabled` among the missing settings, so a delivery to it does nothing. Once it is on, the route behaves like this:

| Request | Response |
| --- | --- |
| Id not in the YAML, or not a valid id | 404 |
| Reviewer disabled, or any required setting missing | 503, with the missing setting names |
| Bad signature | 400 |
| Valid delivery | 202, and the review runs in the background |

An enabled reviewer that is not ready logs one warning naming the missing settings. The other reviewers keep working.

## Limits today

- The improvement corpus (`improve.enabled`, or `IMPROVE_ENABLED`) must stay off for any reviewer other than `claude` and `codex` until the database migration `src/improve/db/migrations/0004_reviewer_expand.sql` is applied. The migration is written and has not been applied. Applying it changes four column types with `ALTER COLUMN ... TYPE text`, which takes an exclusive lock on `finding_catalog`, `finding_discards`, `qc_scores` and `raw_feedback` and rewrites each table. Check the row counts first and run it when nothing is writing to them.
- Reviewers that rely on the shared secret `AI_REVIEW_GITHUB__WEBHOOK_SECRET` use the same secret at every route, so a delivery meant for one of them can pass signature verification at another's route. Give each reviewer its own `WEBHOOK_SECRET` when you can.
- `ai-review review`, `audit`, `gate` and `ready` still run only the Claude and Codex pair. `ai-review watch` takes `--reviewer <id>` (repeatable), and `ai-review replay` takes `--reviewer <id>`.
