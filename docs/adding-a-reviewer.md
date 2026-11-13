# Adding a reviewer

A reviewer is one bot identity: its own GitHub App, its own comment heading, and its own model for each PR size. Claude, Codex and Gemini ship enabled. This page walks through adding another one, using `gemini` as the example id.

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

Leave `enabled: false` for now. Step 4 turns it on for a test repo.

Token prices come from OpenRouter and are cached for 24 hours. If a model shows "cost unavailable" in a review, pin its price under `models.<provider/model>.pricing` in the YAML.

## 2. Create the GitHub App (human step)

Create the app the same way as the Claude app in [Quick Start](quick-start.md), with these differences:

- Name the app so its slug equals `appSlug`.
- Set the webhook URL to `https://<your-domain>/api/github/reviewer/<id>`, for example `https://claude-review-bot.vercel.app/api/github/reviewer/gemini`.
- Pick a webhook secret. Give each reviewer its own (see "Limits today").
- Permissions: Pull requests read and write, Contents read-only, Metadata read-only, Issues read-only. Events: Pull request and Issue comment.
- Generate a private key and note the App ID.

Install the app on one test repo only for now. Installing it is also a human step. You widen the install in step 6.

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

## 4. Enable it on a test repo

A disabled reviewer cannot review anything. The hosted route answers 503 and `ai-review watch` refuses it, so no PR can be reviewed by a new reviewer until it is enabled. That means the replay check has to come after a first real review, and the order is:

1. Confirm the App is installed on the test repo only.
2. Set `enabled: true` for the reviewer in `.ai-review.yaml`, commit, and deploy.
3. Open a PR on the test repo with a real change in it. Give the bot a few rounds if you can: push a fix commit after its first review, or reply to a finding you think is wrong.

Once enabled, the route behaves like this:

| Request | Response |
| --- | --- |
| Id not in the YAML, or not a valid id | 404 |
| Reviewer disabled, or any required setting missing | 503, with the missing setting names |
| Bad signature | 400 |
| Valid delivery | 202, and the review runs in the background |

An enabled reviewer that is not ready logs one warning naming the missing settings. The other reviewers keep working.

## 5. Record the PR and run the live replay

You can trial a new reviewer before it has reviewed anything. `--as <id>` re-runs the recorded claude and codex fixtures through that reviewer's tiers and scores the result against the same confirmed labels. It works while the reviewer is still `enabled: false`, and it needs only the provider API key (for Gemini, `GOOGLE_GENERATIVE_AI_API_KEY`), not the GitHub App settings. An unknown id exits 2, and a missing key exits 1 before any model call.

```bash
ai-review replay --live --as gemini --max-cost 2
```

`--reviewer <id>` still selects which recorded fixtures to use, by the reviewer that produced them. Each fixture prints `live <fixture> as gemini (fixture reviewer claude)`, so the numbers are not mistaken for the native reviewer's. `--as` cannot be combined with `--save-trace`, because a trace saved into a fixture would be attributed to the wrong reviewer.

Once the reviewer is enabled and has reviewed a PR, record that PR and replay it natively. The bot login is the App slug plus `[bot]`:

```bash
ai-review replay --record <pr-url> --reviewer gemini --bot gemini-review-bot[bot]
ai-review replay --live --reviewer gemini --max-cost 2
```

`--live` calls the models and costs real money, and it never gates CI. A round is re-run with the tier model the router picks for that round's diff; per-skill overrides and the summary, triage and revalidate roles are not exercised. `--max-cost` is in USD and defaults to 5. `--rounds <n>` changes how many of the latest rounds are re-run (default 2). The run needs a known price for each model, so pin one under `models.<provider/model>.pricing` if OpenRouter does not list it.

Read these lines of the output:

- `live: N round(s), estimated spend $X (cap $Y)` is the cost estimate for the run. `live: stopping before round ...` means the cap cut it short.
- `round N: ...` appears once per round. `matched rejected` counts re-run findings that restate a claim recorded as rejected, which is the closest thing to a false-positive count. `matched fixed` counts findings that restate a claim the author went on to fix. `new unlabeled` findings carry no accuracy claim, and `candidate retractions` counts findings whose closing sentence takes the claim back.

Only claims in confirmed labels are matched. Labels from a fresh `--record` are provisional, so on a new fixture most findings land in `new unlabeled` until the labels are checked against the PR threads. The code defines no pass or fail threshold, so decide what rate you accept, and compare the new reviewer's `matched rejected` and cost against a run for claude or codex on a comparable PR. The plain `ai-review replay` run (no `--live`) also prints `rejected: X of Y adjudicated`, `recycled` and `restated open` per fixture, again without a threshold.

Gemini's structured output was checked only against a mocked request. The first real review in step 4 and this live run send the review schema to the real Google API, so those are the real test of whether Gemini accepts it.

## 6. Keep it or turn it off

If the results are acceptable, install the App on the other repos (a human step). If they are bad, set `enabled: false` again, commit, and deploy. The bot then stops reviewing, and you can change the tiers and repeat from step 4.

## Roles

A role is a non-finder model call. Each reviewer runs three: `summary` (the review summary), `triage` (reply triage) and `revalidate` (re-checking a finding after a push). Three more are deployment-wide: `qcJudge` and `classifier` (the improvement corpus) and `verifier`. All of them live in `src/roles.ts`. An entry is `{ model: provider/model, effort? }`, and `effort` is checked against the provider like any other model choice.

Precedence for `summary`, `triage` and `revalidate`: `reviewers.<id>.roles.<role>`, then top-level `roles.<role>`, then the default. `qcJudge`, `classifier` and `verifier` exist only at top level.

Defaults, which leave behavior unchanged until YAML sets a role:

- `summary` uses the model that routed the finder.
- `triage` and `revalidate` use a cheap model picked by the finder's provider: `claude-haiku-5-5` at effort `low` for anthropic, `gpt-6-luna` at effort `low` for openai. Any other provider, gemini included, keeps the finder's model with effort `low`.
- `qcJudge` and `classifier` use `anthropic/claude-haiku-5-5` with effort `low`. The QC judge no longer matches the finding's provider, so Codex findings are judged by that model too.

```yaml
roles:
  qcJudge: { model: anthropic/claude-haiku-5-5, effort: low }
reviewers:
  codex:
    roles:
      triage: { model: anthropic/claude-haiku-5-5, effort: low }
```

Env names follow the usual pattern, for example `AI_REVIEW_ROLES__QC_JUDGE__MODEL`. Readiness is per reviewer, so a missing API key for any provider a reviewer's roles use makes the whole reviewer not ready. No individual role is disabled. Hosted mode answers 503 and names the missing variable, and the startup log names it too. Hosted readiness checks the role providers as well as the finder's.

The verifier has a resolver (`resolveVerifier()`) and tests but nothing calls it yet. The call site belongs to epic `ai-review-bot-t0c` (D1), so setting `roles.verifier` changes nothing today.

## Limits today

- The corpus tables (`finding_catalog`, `raw_feedback`, `finding_discards`, `qc_scores`) identify a reviewer only by their `reviewer` column, a required text column, so a new reviewer id needs no migration. A new deployment applies the migrations in order, and the code must not run against a database that has not had `0006_reviewer_contract_prepare` applied: a row written without `provider` fails on the old NOT NULL constraint. Apply `0007_reviewer_contract_drop` only after the code that no longer reads or writes `provider` is deployed everywhere.
- Reviewers that rely on the shared secret `AI_REVIEW_GITHUB__WEBHOOK_SECRET` use the same secret at every route, so a delivery meant for one of them can pass signature verification at another's route. Give each reviewer its own `WEBHOOK_SECRET` when you can.
- `ai-review review`, `audit`, `gate` and `ready` still run only the Claude and Codex pair. `ai-review watch` takes `--reviewer <id>` (repeatable), and `ai-review replay` takes `--reviewer <id>`.
