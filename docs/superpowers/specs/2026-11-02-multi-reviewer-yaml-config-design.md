---
epic: ai-review-bot-dg4
status: approved 2026-11-02; spec hardening, then plan and implementation
---

# Design: multi-reviewer, YAML-driven config

## Context

The bot ships two hard-coded reviewers, Claude and Codex. The `"anthropic" | "openai"` union appears in about 22 non-test files. Tier maps and prices are code constants. Each reviewer is a separate GitHub App with its own config function, webhook route and env var names. Non-finder LLM calls (triage, summary, revalidate, QC judge, classifier) derive their model from the finder's provider.

Other people run this project on their own. They need to enable any subset of reviewers (including none), use whichever providers they have keys for, and tune behavior without editing code. The bot already uses the Vercel AI SDK (`ai` v6). What changes is the per-provider branching, not the SDK.

This design supersedes an earlier proposal ("multi-provider reviewer config and secret storage"). It keeps that proposal's reviewer-not-provider data model, unified webhook route and legacy env aliases. It drops 1Password and the Gateway-only transport.

## Goals

- Add a reviewer with a YAML entry, one GitHub App and env vars. No code change.
- Support providers beyond Claude and Codex (Gemini first; DeepSeek, Moonshot and others later) through direct provider keys.
- Choose models by tier, override them per skill, and choose separate models for non-finder roles.
- One config system. YAML is the source of truth for everything non-secret, and every key can be overridden by an env var derived mechanically from its path.
- Document every key and its env name, generated from the schema.
- Make tier classification (sensitive paths, line thresholds, doc extensions, the `deep-review` label) configuration, not code.
- A live kill switch (Edge Config) that changes selected settings without a redeploy.
- Per-repo override files that let a repo owner tune or disable what the deployment already offers.

## Non-goals

- Gateway transport. The registry design does not block adding it later.
- 1Password or any secret-manager integration in the repo.
- Letting a repo choose models or reviewers the deployment did not define. Per-repo files can only tune or disable (section 7).
- The dashboard. It is a separate project and keeps reading `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, which stay as aliases for the Claude reviewer.

## Anti-goals

- A silent no-op when someone mistypes an emergency override.
- Two different names for the same setting.
- A deploy that crashes because one optional reviewer lacks a secret.

## Approaches

- **A. Five slices, config system and models first (chosen).**
  1. Config system and model resolution, with Claude and Codex reproduced exactly. Tier classifier settings move into config here.
  2. N reviewers: env convention, unified route, DB migration, Gemini.
  3. Judge roles and the D1 verifier hook.
  4. Edge Config live overrides.
  5. Per-repo override files.

  Each slice ships and verifies alone.
- B. Reviewers first. A third bot lands sooner, but Gemini still needs hard-coded tier maps and the model plumbing gets written twice.
- C. One change. No intermediate state to verify, and it touches about 22 files plus the DB.

## Decisions

### 1. Config system (slice 1)

- `config/ai-review.yaml` is committed and bundled with the deployment. It is read once at cold start using the `new URL(..., import.meta.url)` pattern that `src/prompt.ts` already uses for `skills/`.
- One zod schema (`src/config/schema.ts`) is the source of truth for types, defaults, descriptions (`.describe()`) and which keys are secrets.
- Load order is YAML, env overlay, schema defaults, validation, freeze. It is parsed at module scope, so a bad value fails the first request, not mid-review.
- **Env derivation.** The name is `AI_REVIEW_` plus the key path, with `__` between levels, camelCase turned into SCREAMING_SNAKE and hyphens into `_`. Example: `reviewers.gemini-lite.tiers.normal.model` becomes `AI_REVIEW_REVIEWERS__GEMINI_LITE__TIERS__NORMAL__MODEL`.
  - Collections (`reviewers`, `skills`) are maps keyed by id, never lists, so paths stay stable. Ids and skill names match `[a-z][a-z0-9-]*`, so the mapping is reversible.
  - Values are parsed by schema type. Arrays are JSON.
  - Precedence is env, YAML, default.
  - Any env var with the prefix that matches no schema path is a startup error in every environment. The error names the closest valid path. `pnpm config:check` runs the same validation locally and in CI against a given env.
  - The `models:` price table is excluded from derivation, because its keys contain `/` and `.`.
- **Secrets** follow the same rule: `reviewers.claude.privateKey` becomes `AI_REVIEW_REVIEWERS__CLAUDE__PRIVATE_KEY`. The schema rejects a secret present in YAML. `validatePrivateKey` and `normalizePrivateKey` apply unchanged.
- **Provider keys.** The registry passes `apiKey` explicitly from config (`providers.<name>.apiKey`, derived name). Each provider's standard name (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) stays accepted as a documented fallback, because developers already have it set. Non-secret provider settings such as `baseURL` live in YAML.
- **Deprecated names.** Existing vars (`REVIEW_ENABLED`, `AGENT_CONCURRENCY`, `REVIEW_*_DELAY_SECONDS`, `GITHUB_APP_*`, `OPENAI_APP_*`, `QC_APP_*` and the rest) map to derived names through one alias table. Using one logs a deprecation warning once per cold start and names the replacement. They are removed after one release. `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` stay for the Claude reviewer until the dashboard moves.
- **Docs.** A script generates `docs/configuration.md` from the schema: path, env var, type, default, description. CI fails if the file is stale. `/api/debug` reports each effective value and its source (env, YAML or default), with secrets shown only as present or absent.
- **Vercel caveat.** An env change applies on the next deployment, about a minute. The override saves a commit and review, not the redeploy. Keys marked `live` can also change with no redeploy through Edge Config (section 6).
- Infra secrets (`DATABASE_URL`, QStash and KV tokens, `CRON_SECRET`) are env-only under the same convention. `PUBLIC_URL` and `QSTASH_URL` are YAML keys with env override, since they differ per environment.

### 2. Models and resolution (slice 1)

- Model ids are `provider/model`. The prefix picks the provider package from a registry built with `createProviderRegistry` (`@ai-sdk/anthropic`, `openai`, `google`, `deepseek`). Moonshot and other OpenAI-compatible endpoints use `@ai-sdk/openai-compatible` with a `baseURL`. Subscription OAuth in `src/auth.ts` stays a CLI-only path layered on the anthropic and openai providers.
- `models:` holds `pricing` (`input`, `cachedInput`, `output`) and `structuredOutput: native | json`. Every model referenced anywhere needs an entry, and the schema cross-checks. This replaces `TOKEN_RATES`, and `computeCost` starts counting cached tokens.
- **Resolution order for a finder agent:** `skills.<skill>.<tier>`, then `skills.<skill>`, then `tiers.<tier>` (or `tiers.default`). Skill names are validated against `TIER1_SKILLS` plus the Tier 2 detector paths (`src/review.ts:441`), so a typo fails CI. `runOn` limits a reviewer to some tiers.
- Effort translation stays in code: one small function per provider prefix, each with a test. A per-entry `providerOptions` escape hatch merges on top.
- Mixed models inside one reviewer split the prompt cache, because caches are per model. The first-agent-alone pass in `runAgent` runs once per distinct model in the reviewer's resolved set.

Example reviewer:

```yaml
reviewers:
  gemini:
    appId: 0000000
    appSlug: gemini-review-bot
    commentPrefix: gemini-review-bot
    tiers:
      trivial: { model: google/gemini-3.1-flash-lite, effort: low }
      normal:  { model: google/gemini-3.1-flash-lite, effort: medium }
      complex: { model: google/gemini-3.8-flash,      effort: medium }
      deep:    { model: google/gemini-3.8-flash,      effort: high }
    skills:
      code-reviewer:         { normal: { model: google/gemini-3.8-flash, effort: medium } }
      security-sast:         { normal: { model: google/gemini-3.8-flash, effort: medium } }
      silent-failure-hunter: { normal: { model: google/gemini-3.8-flash, effort: low } }
      security-auditor:      { deep:   { model: google/gemini-4-argon,   effort: high } }
    roles:
      summary:    { model: google/gemini-3.1-flash-lite, effort: low }
      triage:     { model: google/gemini-3.1-flash-lite, effort: low }
      revalidate: { model: google/gemini-3.1-flash-lite, effort: low }
```

Model ids and prices here are placeholders. The builder confirms them against provider pages and the AI SDK provider docs, including Google's thinking option name, before committing.

### 3. N reviewers (slice 2)

- `reviewers` is a map. Each entry has `enabled`, `appId`, `appSlug`, `commentPrefix`, and optionally `concurrency`, `runOn`, tiers, skills and roles. A reviewer with no private key or webhook secret is disabled with one cold-start log line, never a crash. Zero enabled reviewers is valid.
- Webhook secret: `reviewers.<id>.webhookSecret`, falling back to a shared `github.webhookSecret`.
- One route, `api/github/reviewer/[id].ts`. An unknown id returns 404 before signature checking, and a disabled reviewer returns 503. `webhook.ts` and `webhook-openai.ts` become wrappers for `claude` and `codex`. `vercel.json` gets an `api/github/**/*.ts` glob so new routes keep `maxDuration: 300`. The QStash `review-run` message carries the reviewer id.
- `getConfig` and `getOpenAIAppConfig` collapse into `getReviewerAppConfig(id)`. `getGitHubApp` and `getOpenAIGitHubApp` collapse into `getReviewerGitHubApp(id)`.
- **Data model.** `provider` stops being an identity. In Postgres, add `reviewer text not null` to the three tables that carry `provider`, backfill `anthropic` to `claude` and `openai` to `codex`, change `provider` from `pgEnum` to `text`, and move the `(provider, owner, repo, pr)` indexes to `reviewer`. Replay fixtures with `provider` load through the same mapping. KV keys, the ledger and feedback attribution switch to reviewer id or `appSlug`. Peer exclusion takes our own logins from `appSlug` across all reviewers.
- Adding Gemini: create the App with `enabled: false`, run `ai-review replay --live --max-cost <usd>`, and enable it if false-positive rate and cost hold. Run `ModelReviewSchema` through `generateObject` on Flash-Lite first, because Gemini accepts only a subset of the schema language.

### 4. Judge roles (slice 3)

- Per-reviewer roles (`summary`, `triage`, `revalidate`) default to the reviewer's cheapest tier model, as today.
- Deployment-wide top-level `roles:` cover judge-type calls: `verifier`, `qcJudge`, `classifier`, and later `adjudicator` and `auditor`. They replace `judgeSelection`, the classify selection and the triage-derived picks.
- A role may declare `differentFrom: finder`. The verifier (epic `ai-review-bot-t0c`, D1) uses it. If only one provider is configured, the verifier is skipped and findings count as unverified, matching D1's outage behavior.
- F1's per-role routing for defect and security skills is expressed through `skills:` overrides, driven by C3 data.

### 5. Tier classification as config (slice 1)

A `routing:` block replaces the constants in `src/router.ts`: `sensitivePathPatterns`, `docExtensions`, `deepLabel` (default `deep-review`), and the size thresholds. The thresholds are `complexLines: 500` and `trivialDocLines: 20`, which applies only when every file is a doc file; both are read from `classifyTier` (`src/router.ts:56`). The router's comment that Opus `deep` uses `high` and not `xhigh` moves into the YAML beside that tier. `xhigh` can outlast the 210s agent deadline on Hobby.

Defaults equal today's values, so behavior is unchanged. The block is deployment-wide, not per reviewer, because every reviewer must classify a PR the same way. `classifyTier` reads the frozen config instead of module constants, and its existing tests become the equivalence check.

### 6. Edge Config live overrides (slice 4)

- Goal: change selected settings in seconds with no redeploy, most importantly disabling one reviewer or all review.
- Edge Config holds a flat JSON map whose keys are the same derived env names (`AI_REVIEW_REVIEWERS__GEMINI__ENABLED`), so there is still one naming scheme. It is read per request through `@vercel/edge-config` with a short in-memory cache, and layered on top of the cold-start config.
- Only schema keys marked `live` are accepted: reviewer `enabled`, `review.enabled`, delays, budgets, concurrency and the `verifier` toggle. Everything else is frozen at cold start (models, App credentials, tiers) and is rejected here.
- Precedence becomes Edge Config, env, YAML, default. An unknown or non-`live` key in Edge Config is ignored for requests and reported at the top of `/api/debug`. A live typo must not crash a running bot. That is the opposite of the env rule, because Edge Config is edited under pressure with no deploy gate.
- `EDGE_CONFIG` (the connection string) is env-only and optional. Without it the layer is off. The builder confirms current `@vercel/edge-config` read semantics and plan limits.

### 7. Per-repo override files (slice 5)

- The file is `.github/ai-review.yml` in the repo under review, fetched through the GitHub API from the **default branch**, never the PR head, so a PR author cannot change how their own PR is reviewed.
- It uses a subset of the deployment schema, validated separately. A repo may disable a reviewer or skill, restrict `runOn`, add `routing.sensitivePathPatterns`, raise (not lower) severity floors, set a `customPrompt`, and set `review.command`. It cannot enable a disabled reviewer, add a model, change an App, or exceed deployment budgets. The deployment config is a ceiling.
- It is fetched once per review run and cached in KV per default-branch SHA. An invalid file is ignored, with a one-line note in the review body naming the problem. It never fails a review.
- Env and Edge Config outrank a repo file, so an Edge Config disable always wins.

### 8. Details settled after the builder check

- **DB migration is expand/contract.** Expand (slice 2): add a nullable `reviewer` column, backfill it, keep `provider` as `text`, and have new code write both and read `reviewer`. Contract (a later PR, after one release): drop `provider`. No migration is applied to production without an explicit go-ahead.
- **The QC bot is not a reviewer.** It stays a singleton App with its own `qc:` block (`appId`, `appSlug`, secrets; the webhook route is unchanged). Its judge model is `roles.qcJudge`. The same-provider rule in `judgeSelection` goes away, so the QC judge is just the configured model.
- **Env overlay on maps.** Env overrides values of keys that exist in YAML. It cannot create a map entry, because a reviewer needs tiers that one env var cannot express. Secrets for a reviewer id that is not in YAML log a warning, not an error, so a deployer who trims the YAML is not blocked.
- **Roles precedence.** `reviewers.<id>.roles.<role>`, then top-level `roles.<role>`, then the reviewer's cheapest tier model. Judge-only roles (`verifier`, `qcJudge`, `classifier`) exist only at top level.
- **Cost.** The equivalence test covers model and effort resolution only. Footer cost changes because cached tokens are now counted. The circuit breaker counts reviews, not dollars, so it is unaffected. `--max-cost` uses the new figure.
- **In-flight QStash messages.** For one release, `review-run` accepts a missing reviewer id and infers it from the legacy provider.
- **Provider and key validation.** The schema always checks the model id prefix against the registry. Missing provider keys are checked only for enabled reviewers and for roles in use. A role or reviewer whose key is missing is disabled with a log line.

## Constraints

- Claude and Codex keep working with no GitHub App or Vercel env changes through slices 1 and 2, via aliases.
- The hosted path stays inside the 210s agent budget. Direct provider calls add no network hop.
- `src/auth.ts` and the CLI subscription path stay CLI-only. Webhook paths never import them.
- Spec, plan and code for each slice land on one branch and one PR.
- Merge only after the owner approves, after the sprint in progress.

## Left to the builder

- The exact zod structure for the env overlay walker and the closest-path suggestion.
- The alias table contents, enumerated from `src/config.ts` and `.env.example`.
- Whether `providers.<name>` needs more than `apiKey` and `baseURL`.
- Cost-estimate and effort-mapping details per provider, after reading current docs.

## Calls made without asking

- The config file is `config/ai-review.yaml`, not `reviewers.yaml`, since it holds everything.
- `reviewers` and `skills` are maps, not lists.
- Standard provider key names stay as permanent fallbacks. All behavior aliases are deprecated.
- `models:` is excluded from env derivation.
- App ID is a YAML key with env override. Committing it is fine for the maintainer, and forks can override it without editing the file.
- Edge Config, per-repo overrides and tier thresholds are in scope (owner's request on the draft).
- Edge Config uses the same derived key names, accepts only `live` keys, and ignores bad keys instead of crashing.
- Per-repo files are read from the default branch and can only tune or disable.

## Testing and verification

- Schema rejects: a missing tier without a default, an unknown model reference, duplicate ids, a bad model id, a secret in YAML, an unknown skill name.
- Env overlay: derived name beats YAML, YAML beats default, an alias warns and maps, an unknown prefixed var errors with a suggestion, values are coerced per schema type.
- Equivalence: for every (skill, tier), the new resolver returns what `routeModel` returns today for Claude and Codex. Tier classification returns what `classifyTier` returns today.
- The docs generator output is current (CI).
- Route: unknown id returns 404, disabled returns 503, and the legacy routes map to `claude` and `codex`.
- `computeCost` with cached tokens, and effort mapping per provider.
- DB backfill and fixture loading.
- Edge Config: only `live` keys apply, a bad key is reported and ignored, and a missing connection string turns the layer off.
- Per-repo file: read from the default branch only, cannot raise privileges, and an invalid file adds a note and does not fail the review.
- For each new reviewer, `ai-review replay --live` runs before `enabled: true`, and never in CI.
- Gates per slice: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
