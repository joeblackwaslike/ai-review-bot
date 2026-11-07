# Multi-reviewer YAML config, slice 2: N reviewers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two hard-wired Claude and Codex bots with reviewers defined in `.ai-review.yaml`: any number of them, on Anthropic, OpenAI or Google models, with per-skill model overrides, one webhook route, and reviewer (not provider) as the identity everywhere.

**Architecture:** `ModelSelection.provider` widens to a closed `ProviderName` set served by one AI SDK provider registry. A reviewer entry gains app identity, `runOn`, `concurrency` and `skills`. Secrets are read from derived env names outside the frozen config tree. `reviewer` replaces `provider` in runtime identity, with the legacy form (`anthropic`, `openai`) kept wherever it is already persisted (KV keys, DB `provider` column, GitHub markers) so nothing already on GitHub or in storage is orphaned. One route, `api/github/reviewer/[id].ts`, serves every reviewer.

**Tech Stack:** TypeScript ESM, zod 4, `ai` v6, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` (new), drizzle + pg-mem, Vitest, biome, pnpm.

**Spec:** [docs/superpowers/specs/2026-11-02-multi-reviewer-yaml-config-design.md](../specs/2026-11-02-multi-reviewer-yaml-config-design.md). Sections 1 to 3 and 8 govern this plan. Slice 1 is [docs/superpowers/plans/2026-11-02-multi-reviewer-config-slice-1.md](2026-11-02-multi-reviewer-config-slice-1.md) and is already built (config schema, env overlay, loader, router tiers, OpenRouter prices). Slices 3 to 5 are not in this PR.

## Rulings against the spec

- **Four tables carry `provider`, not three.** `finding_catalog`, `raw_feedback`, `qc_scores` and `finding_discards`. All four get the expand step.
- **Legacy identity string.** `legacyProviderOf(id)` returns `anthropic` for `claude`, `openai` for `codex`, and the id itself otherwise. It is what the old `provider` field, column, KV key and marker held, so natural keys, the `finding_discards_uq` unique index and in-flight KV records keep working. `reviewer` is canonical in code.
- **The unique index stays on `provider` during expand.** Old writers insert `provider` only; a NULL `reviewer` would defeat a unique index on it. Moving it is the contract step.
- **Deferred to slice 3:** the `qc:` block (QC keeps `QC_*` env and `getQcAppConfig` unchanged) and per-reviewer `roles:`. Until then a non-finder call (triage, summary) for a provider other than anthropic or openai uses the finder's own model at effort `low`, never another provider's credentials.
- **CLI scope.** `review`, `audit`, `gate` and `ready` stay on the Claude and Codex pair. `watch` and `replay` gain `--reviewer <id>`; `--provider` keeps working as an alias.
- **Aliases.** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and the standard provider key names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) are permanent and never warn. `GITHUB_WEBHOOK_SECRET`, `OPENAI_APP_*`, `REVIEW_COMMENT_PREFIX` and `OPENAI_REVIEW_COMMENT_PREFIX` are deprecated and warn once per cold start.
- **Google SDK.** `@ai-sdk/google@3.0.137` (published 2026-10-21, older than two weeks; 3.0.141 is the latest). Read from the packed tarball before writing this plan: `providerOptions.google.thinkingConfig` takes `thinkingBudget?: number`, `thinkingLevel?: "minimal" | "low" | "medium" | "high"` and `includeThoughts?: boolean`; the model id type lists `gemini-3.8-flash` and `gemini-4-argon` but not `gemini-3.1-flash-lite` (a `string & {}` member allows it). Task 1 re-checks this against the installed copy.

## Global Constraints

Copied from the spec.
- Env name is `AI_REVIEW_` plus the key path, `__` between levels, camelCase to SCREAMING_SNAKE, hyphens to `_`. Precedence is env, YAML, default.
- Collections (`reviewers`, `skills`) are maps keyed by id. Ids and skill names match `[a-z][a-z0-9-]*`.
- Secrets follow the same rule (`reviewers.claude.privateKey` is `AI_REVIEW_REVIEWERS__CLAUDE__PRIVATE_KEY`). The schema rejects a secret present in YAML. `validatePrivateKey` and `normalizePrivateKey` apply unchanged.
- The registry passes `apiKey` explicitly from config (`providers.<name>.apiKey`, derived name). Each provider's standard name stays accepted as a documented fallback.
- Webhook secret is `reviewers.<id>.webhookSecret`, falling back to a shared `github.webhookSecret`.
- A reviewer with no private key or webhook secret is disabled with one cold-start log line, never a crash. Zero enabled reviewers is valid.
- Resolution order for a finder agent: `skills.<skill>.<tier>`, then `skills.<skill>`, then `tiers.<tier>`. Skill names are validated against `TIER1_SKILLS` plus the Tier 2 detector paths. Loading fails on an effort the model cannot take.
- Auth is bound to the selected provider. `createAIModel` rejects a credential whose provider differs from the model's provider.
- Mixed models inside one reviewer split the prompt cache; the first-agent-alone pass runs once per distinct model.
- An unknown reviewer id returns 404 before signature checking; a disabled reviewer returns 503. `vercel.json` gets an `api/github/**/*.ts` glob so new routes keep `maxDuration: 300`.
- `review-run` accepts a missing reviewer id for one release and infers it from the legacy provider.
- Ownership matches on reviewer id and also accepts the legacy provider marker (`anthropic` as `claude`, `openai` as `codex`, an absent marker as today). New reviews write both markers for one release.
- DB migration is expand only. Reads use `coalesce(reviewer, mapped(provider))`, never `reviewer` alone. No migration is applied to production without an explicit go-ahead.
- Env overlay cannot create a map entry. Secrets for a reviewer id that is not in YAML log a warning, not an error.
- Claude and Codex keep working with no GitHub App or Vercel env changes, via aliases.
- `src/auth.ts` and the CLI subscription path stay CLI-only; webhook paths never import them.
- Repo conventions: ESM with `.js` import extensions, named exports only, colocated tests, biome, conventional commits, no inline comments or section banners. Run tests as `pnpm test <path>`.
- Do not apply any migration and do not merge. Gemini stays `enabled: false`.

## Review Focus

Input classes the spec implies but its tests would not exercise on their own. Each has a test in the owning task.
1. A review already on GitHub that carries only the legacy `ai-review:provider` marker, or no marker: same-head dedup, carried blockers and ledger must still treat it as ours. (Tasks 8, 9)
2. Hostile or odd reviewer ids in the route (`__proto__`, `constructor`, uppercase, 300 characters, `?id=a&id=b`): 404 before any body read, never a prototype hit. (Task 12)
3. A QStash message with only `provider`, with both fields, with neither, and with an unknown reviewer id. (Task 13)
4. Partial credentials: a key but no app id, a webhook secret only, env secrets for a reviewer absent from YAML, zero enabled reviewers. None may crash a cold start. (Tasks 6, 7, 12)
5. Two reviewers on the same provider and model: claim keys, natural keys, ledger and feedback rows must stay separate. A skill override that mixes models must price each agent with its own model. (Tasks 9, 11, 15)

## File Structure

- Create `src/providers/names.ts`, `src/providers/registry.ts`, `src/providers/effort.ts`, `src/providers/credentials.ts`: provider set, registry, effort translators, credential lookup.
- Create `src/skill-names.ts`: leaf module for skill names (schema cannot import `review.ts`).
- Create `src/reviewer-id.ts`: `ReviewerId`, `legacyProviderOf`, `reviewerFromLegacy`.
- Create `src/reviewers.ts`: `getReviewerAppConfig`, readiness, errors.
- Create `src/webhook-handler.ts` and `api/github/reviewer/[id].ts`.
- Modify `src/config/schema.ts`, `src/config/env.ts`, `src/config/docs.ts`, `.ai-review.yaml`, `src/config.ts`, `src/router.ts`, `src/models.ts`, `src/triage.ts`, `src/notify.ts`, `src/concurrency.ts`, `src/review.ts`, `src/review-metadata.ts`, `src/github-app.ts`, `src/scheduler.ts`, `src/discards.ts`, `src/resolve-threads.ts`, `src/ledger/{github,live}.ts`, `src/feedback/*`, `src/improve/{capture,drain,qc,backfill}.ts`, `src/improve/db/{schema,repo}.ts`, `src/watch.ts`, `src/cli.ts`, `src/replay/*`, `src/agent-log.ts`, `src/testing.ts`, `api/github/{webhook,webhook-openai,review-run}.ts`, `api/cron/poll-feedback.ts`, `api/debug.ts`, `vercel.json`, `package.json`, `CLAUDE.md`, `.env.example`, `docs/configuration.md` (generated).
- Types that keep the Claude and Codex pair only (`src/auth.ts`, `src/audit.ts`, `src/gate/*`, `src/mistakes/*`) import `LegacyProvider` from `src/reviewer-id.ts` instead of repeating the union.

Every task ends the same way: run the task's tests (expect PASS), then `pnpm typecheck && pnpm lint && pnpm test <task's test paths>`, then commit. Where a step says "Run (red)", the expected result is a FAIL for the stated reason.

---

### Task 1: Google dependency, provider set, registry

**Files:**
- Create: `src/providers/names.ts`, `src/providers/registry.ts`, `src/providers/credentials.ts`, and a `.test.ts` beside each
- Modify: `package.json`, `src/router.ts` (`ModelSelection.provider`), `src/models.ts` (`createAIModel`)

**Interfaces:**
- Produces:
  ```ts
  export const PROVIDER_NAMES: readonly ["anthropic", "openai", "google"];
  export type ProviderName = (typeof PROVIDER_NAMES)[number];
  export function isProviderName(value: string): value is ProviderName;
  export function splitModelId(id: string): { provider: ProviderName; model: string }; // throws naming the id and the allowed providers
  export interface ProviderCredentials { apiKey?: string; baseURL?: string }
  export function resolveProviderCredentials(provider: ProviderName, env?: Readonly<Record<string, string | undefined>>): ProviderCredentials; // Task 1: standard env names only
  export function createModelRegistry(creds: Partial<Record<ProviderName, ProviderCredentials>>, opts?: { fetch?: typeof fetch }): ReturnType<typeof createProviderRegistry>;
  export function createAIModel(selection: ModelSelection, auth?: ResolvedAuth): LanguageModel; // existing export, now exhaustive over ProviderName
  ```
- `ModelSelection.provider` becomes `ProviderName`.

- [ ] **Step 1: Add the dependency.** `pnpm add --save-exact @ai-sdk/google@3.0.137` (exact on purpose, unlike the caret siblings). Then confirm the option names in the installed copy: `rg -n 'thinkingLevel|thinkingBudget|includeThoughts' node_modules/@ai-sdk/google/dist/index.d.ts`. Expected: the three names from the Rulings section. If they differ, stop and fix Tasks 2 and 3 to match what is installed.
- [ ] **Step 2: Write failing tests.**
  - `names.test.ts`: `isProviderName("google")` true, `("gemini")` false; `splitModelId("google/gemini-3.8-flash")` returns `{provider:"google", model:"gemini-3.8-flash"}`; `splitModelId("claude-sonnet-5-5")` and `splitModelId("moonshot/kimi")` throw with the id in the message.
  - `registry.test.ts`: a recording `fetch` is passed through `createModelRegistry({anthropic:{apiKey:"a"},openai:{apiKey:"o"},google:{apiKey:"g"}}, {fetch})`; one `generateText` call per provider (canned minimal JSON body per provider) asserts the key arrives as `x-api-key` (anthropic), `authorization: Bearer o` (openai) and `x-goog-api-key` (google).
  - `credentials.test.ts`: `resolveProviderCredentials("google", {GOOGLE_GENERATIVE_AI_API_KEY:"k"})` returns `{apiKey:"k"}`; blank value is unset.
  - in `src/models.test.ts` (extend): `createAIModel({provider:"google", model:"gemini-3.8-flash"})` with the key in env returns a model whose `provider` starts with `google`; with an anthropic `auth` it throws `/cannot be used with a google model/`.
- [ ] **Step 3: Run (red).** `pnpm test src/providers src/models.test.ts`. Expected: FAIL, modules not found.
- [ ] **Step 4: Implement** the modules per Interfaces. The registry is built with `createProviderRegistry({anthropic, openai, google}, { separator: "/" })` from `ai`, each provider created with `{apiKey, baseURL, fetch}` from its credentials. In `createAIModel`, the OAuth and explicit-`auth` branches for anthropic and openai stay exactly as they are; the no-auth path for those two, and the whole path for google, goes through the registry using `resolveProviderCredentials`. A `google` selection with any `auth` throws the existing "cannot be used" error. Fix every compile error the widened union causes with the smallest change (`src/notify.ts` `providerLabel` gets a `google` label `Google`); do not rename identity fields yet.
- [ ] **Step 5: Run (green)** the tests from Step 3, then the standard tail. Commit `feat(providers): add provider set, registry and google dependency`.

---

### Task 2: Effort translation per provider

**Files:**
- Create: `src/providers/effort.ts`, `src/providers/effort.test.ts`
- Modify: `src/router.ts` (`reasoningProviderOptions` delegates; same export), `src/config/schema.ts` (`ModelSchema` gains `effortControl` and `providerOptions`)

**Interfaces:**
- Consumes: `ProviderName` (Task 1).
- Produces:
  ```ts
  export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
  export type EffortControl = "level" | "budget";
  export function supportedEfforts(provider: ProviderName, control?: EffortControl): readonly Effort[];
  export function anthropicOptions(effort: Effort | undefined, refusalFallback: boolean): { effort?: string; fallbacks?: "default" } | undefined;
  export function openaiOptions(effort: Effort | undefined): { reasoningEffort: string } | undefined;
  export function googleOptions(effort: Effort | undefined, control?: EffortControl): { thinkingConfig: { thinkingLevel?: "minimal" | "low" | "medium" | "high"; thinkingBudget?: number; includeThoughts: false } } | undefined; // control defaults to "level"
  export function mergeProviderOptions(base: ProviderOptions | undefined, extra: Record<string, Record<string, unknown>> | undefined): ProviderOptions | undefined; // extra wins per key, shallow per provider
  ```
- Supported sets: anthropic `low medium high xhigh max`; openai `none low medium high xhigh`; google `level` is `none low medium high` (`none` becomes `minimal`), google `budget` is `none low medium high` with budgets 0, 1024, 8192, 24576. `xhigh` and `max` on google throw.
- `ModelSchema` additions: `effortControl?: "level" | "budget"` (describe: how a Google model takes reasoning effort) and `providerOptions?: Record<string, Record<string, unknown>>` (describe: merged over the computed options). Both sit under `models`, which env derivation already excludes.

- [ ] **Step 1: Write failing tests** in `effort.test.ts`:
  - `anthropicOptions("high", true)` equals `{effort:"high", fallbacks:"default"}`; `("none")` returns `undefined`-effort path unchanged from today (assert against the existing `router.test.ts` expectations so Claude equivalence holds); `openaiOptions("none")` equals `{reasoningEffort:"none"}`.
  - `googleOptions("low")` equals `{thinkingConfig:{thinkingLevel:"low", includeThoughts:false}}`; `("none")` gives `thinkingLevel:"minimal"`; `("medium","budget")` gives `thinkingBudget:8192`; `("xhigh")` throws naming the effort.
  - `supportedEfforts` table assertions for all provider and control pairs above.
  - `mergeProviderOptions` lets `{google:{thinkingConfig:{thinkingBudget:42}}}` override the computed block.
  - extend `router.test.ts`: `reasoningProviderOptions({provider:"google", model:"gemini-3.8-flash", effort:"high"})` returns `{google:{thinkingConfig:{thinkingLevel:"high", includeThoughts:false}}}`, and a `models` entry with `effortControl: budget` switches it to a budget.
- [ ] **Step 2: Run (red).** `pnpm test src/providers/effort.test.ts src/router.test.ts`.
- [ ] **Step 3: Implement** the translators as pure functions and make `reasoningProviderOptions(selection)` look up `getConfigTree().models["provider/model"]` for `refusalFallback`, `effortControl` and `providerOptions`, call the matching translator, then `mergeProviderOptions`. The budget constants are named exports; the builder confirms the ranges against Google's thinking docs and says in the PR what was checked.
- [ ] **Step 4: Run (green)**, tail. Commit `feat(providers): translate effort per provider`.

---

### Task 3: Gemini structured-output check against a mocked Google endpoint

**Files:**
- Create: `src/providers/google-structured-output.test.ts`
- Modify: `src/review.ts` only if the test shows `ModelReviewSchema` cannot be sent to Gemini (see Step 3)

**Interfaces:**
- Consumes: `createAIModel`, `reasoningProviderOptions` (Tasks 1, 2), `ModelReviewSchema` and `buildModelReview` (`src/testing.ts`).

- [ ] **Step 1: Write the failing test.** Call `generateObject({model, schema: ModelReviewSchema, providerOptions: reasoningProviderOptions(sel), messages})` where `model` comes from `createModelRegistry({google:{apiKey:"k"}}, {fetch})` and `fetch` records the request and returns a Gemini `generateContent` body: `{candidates:[{content:{role:"model",parts:[{text: JSON.stringify(buildModelReview())}]},finishReason:"STOP"}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15}}`. Assertions:
  - the URL contains `models/gemini-3.1-flash-lite:generateContent`;
  - the body has `generationConfig.responseMimeType === "application/json"` and a `generationConfig.responseSchema`;
  - a recursive walk of `responseSchema` finds no key named `additionalProperties`, `$schema`, `$ref`, `$defs` or `const`;
  - `generationConfig.thinkingConfig.thinkingLevel === "low"` for effort `low`;
  - the returned object parses with `ModelReviewSchema`, and `usage.inputTokens === 10`.
- [ ] **Step 2: Run (red or green).** `pnpm test src/providers/google-structured-output.test.ts`. If it passes on the first run the provider already strips unsupported keywords; keep the test as the regression guard.
- [ ] **Step 3: If the walk finds a rejected keyword**, do not weaken `ModelReviewSchema` for the other providers. Convert for Google only, in `createAIModel`'s google path or the `generateObject` call site, and record the finding in the PR body. This test is the no-network proxy for the spec's "run `ModelReviewSchema` through `generateObject` on Flash-Lite first"; the live Flash-Lite call is the human replay step after merge.
- [ ] **Step 4:** tail. Commit `test(providers): pin Gemini structured output request shape`.

---

### Task 4: Non-finder calls stay on their own provider

**Files:**
- Modify: `src/router.ts`, `src/triage.ts`, `src/improve/qc.ts`, `src/notify.ts`; tests `src/router.test.ts`, `src/triage.test.ts`, `src/improve/qc.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function cheapSelection(base: ModelSelection): ModelSelection;
  export function judgeSelection(identity: string): ModelSelection; // widened from the two-value union
  ```

- [ ] **Step 1: Write failing tests.**
  - `cheapSelection({provider:"anthropic",...})` equals `{provider:"anthropic", model:"claude-haiku-5-5", effort:"low"}`; openai gives `gpt-6-luna` at `low`; `{provider:"google", model:"gemini-3.8-flash", effort:"high"}` gives provider `google`, the same model, effort `low`. No result for a google base may have provider `anthropic`.
  - `triageReReview` called with a google selection builds its model with provider `google` (spy on `createAIModel`).
  - `judgeSelection("anthropic")` and `("gemini")` return the anthropic QC model; `("openai")` returns the openai one (unchanged behavior for existing rows).
- [ ] **Step 2: Run (red).** `pnpm test src/router.test.ts src/triage.test.ts src/improve/qc.test.ts`.
- [ ] **Step 3: Implement.** Move `triageSelection` out of `triage.ts` into `router.ts` as `cheapSelection` and use it at both call sites. `judgeSelection` takes a string and keeps its two branches.
- [ ] **Step 4:** green, tail. Commit `fix(models): keep non-finder calls on the finder's provider`.

---

### Task 5: Skill names and reviewer schema

**Files:**
- Create: `src/skill-names.ts`, `src/skill-names.test.ts`
- Modify: `src/config/schema.ts`, `src/review.ts` (`TIER1_SKILLS` imports from `skill-names.ts`), `.ai-review.yaml`; tests `src/config/schema.test.ts`, `src/config/describe.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TIER1_SKILL_FILES: readonly string[];  // the current TIER1_SKILLS values
  export const TIER2_SKILL_FILES: readonly string[];  // the skillPath of each TIER2_DETECTORS entry
  export const SKILL_NAMES: ReadonlySet<string>;      // base names without ".md"
  ```
- `ReviewerSchema` adds (all `.strict()`, all `.describe()`d): `appId?: z.coerce.string().regex(/^\d+$/)`; `appSlug?: string` (`/^[a-z0-9][a-z0-9-]*$/i`); `commentPrefix?: string` (min 1); `concurrency?: int >= 1`; `runOn?: TierSchema[]` (min 1, unique); `skills?: record(skill name, SkillChoice)` where `SkillChoice = { model?, effort?, trivial?, normal?, complex?, deep? }` (each tier key a `TierChoiceSchema`), refined so it has a `model` or at least one tier key, and `effort` only with `model`.
- `ConfigSchema` adds `providers: record(ProviderName, { baseURL?: string })` defaulting to `{}`.
- Cross-checks (all `superRefine`, each issue path pointing at the offender): every model id's prefix is in `PROVIDER_NAMES` (models keys, tier models, skill models); every effort is in `supportedEfforts(provider, models[id]?.effortControl)`; skill names are in `SKILL_NAMES`; no two reviewers share an `appSlug`. Duplicate `commentPrefix` is allowed (both bots share the default heading today).

- [ ] **Step 1: Write failing tests.**
  - `skill-names.test.ts`: `TIER2_SKILL_FILES` equals `TIER2_DETECTORS.map(d => d.skillPath)`; `TIER1_SKILL_FILES` equals the five Tier 1 files; `SKILL_NAMES.has("code-reviewer")`.
  - `schema.test.ts`, one test each: `rejects a model with an unknown provider prefix` (`moonshot/kimi`); `rejects an effort the model cannot take` (anthropic `none`, google `xhigh`, google `budget` model with `max`); `rejects an unknown skill name` (`code-reviwer`); `rejects a skills entry with effort and no model`; `rejects a duplicate appSlug`; `rejects an empty runOn and a duplicate tier in runOn`; `rejects a secret key in a reviewer` still (`privateKey`, `webhookSecret`, `apiKey` are unknown keys); `accepts appId as a YAML number and coerces it to a string`; `accepts the repo's real .ai-review.yaml`.
  - `describe.test.ts` keeps passing, so every new leaf has a description.
- [ ] **Step 2: Run (red).** `pnpm test src/skill-names.test.ts src/config`.
- [ ] **Step 3: Implement** the schema. Update `.ai-review.yaml`: `appSlug` and `commentPrefix` for `claude` (`anthropicreviewbot`, `ai-review-bot`), `codex` (`codexreviewbot`, `codex-review-bot`) and `gemini` (`gemini-review-bot`, `gemini-review-bot`); `models.google/gemini-3.1-flash-lite: { effortControl: level }`. Leave `appId` out of the file for all three (Claude and Codex come from env aliases; Gemini has no App yet).
- [ ] **Step 4:** green; also run `pnpm config:check` (needs Bun). Tail. Commit `feat(config): reviewer app identity, runOn, skills and provider cross-checks`.

---

### Task 6: Env aliases with several paths, and secrets

**Files:**
- Modify: `src/config/env.ts`, `src/config/docs.ts`, `src/providers/credentials.ts`, `api/debug.ts`; tests `src/config/env.test.ts`, `src/providers/credentials.test.ts`

**Interfaces:**
- `AliasEntry` becomes `{ paths: readonly (readonly string[])[]; deprecated: boolean }`. For a path with several aliases the earlier table entry wins. New entries: `GITHUB_APP_ID` to `reviewers.claude.appId` (permanent); `OPENAI_APP_ID` to `reviewers.codex.appId`; `OPENAI_REVIEW_COMMENT_PREFIX` to `reviewers.codex.commentPrefix`; `REVIEW_COMMENT_PREFIX` to both `reviewers.claude.commentPrefix` and `reviewers.codex.commentPrefix` (listed after the OpenAI one); the last three deprecated.
- Produces:
  ```ts
  export interface SecretSpec { reviewer?: string; path: readonly string[]; envName: string; aliases: readonly { name: string; deprecated: boolean }[] }
  export function secretSpecs(config: Pick<Config, "reviewers">): SecretSpec[];
  export function readSecret(spec: SecretSpec, env: Readonly<Record<string, string | undefined>>): { value?: string; warnings: string[] };
  export const SHARED_WEBHOOK_SECRET: SecretSpec; // github.webhookSecret, AI_REVIEW_GITHUB__WEBHOOK_SECRET
  export function providerKeySpec(provider: ProviderName): SecretSpec;
  export function describeSecrets(config: Pick<Config, "reviewers">, env: Env): Record<string, "present" | "absent">;
  ```
- Secret specs: per reviewer id `privateKey` and `webhookSecret`; per provider `apiKey`; plus the shared webhook secret. Legacy aliases: claude `privateKey` from `GITHUB_APP_PRIVATE_KEY` (permanent) and `webhookSecret` from `GITHUB_WEBHOOK_SECRET`; codex from `OPENAI_APP_PRIVATE_KEY` and `OPENAI_APP_WEBHOOK_SECRET` (both deprecated); providers from the three standard names (permanent).
- Secrets never enter the overlay result or the frozen tree.

- [ ] **Step 1: Write failing tests.**
  - `env.test.ts`: `derived name beats alias for appId and warns`; `REVIEW_COMMENT_PREFIX sets both claude and codex prefixes, OPENAI_REVIEW_COMMENT_PREFIX wins for codex`; `GITHUB_APP_ID is accepted with no warning`; `OPENAI_APP_ID warns once and names AI_REVIEW_REVIEWERS__CODEX__APP_ID`.
  - secrets: `AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY is accepted when gemini is in the config`; `the same name for a reviewer absent from YAML produces a warning, not an UnknownConfigEnvError`; `AI_REVIEW_PROVIDERS__GOOGLE__API_KEY is accepted without a providers.google YAML entry`; `readSecret prefers the derived name over the standard name`; `blank is unset`; `a secret value never appears in applyEnvOverlay's value or sources`; a typo `AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEYS` still throws with the closest name.
  - `credentials.test.ts`: `resolveProviderCredentials` now returns the derived-name key first, then the standard name, plus `baseURL` from `providers.<name>.baseURL`.
  - `describeSecrets` returns presence only.
- [ ] **Step 2: Run (red).** `pnpm test src/config src/providers/credentials.test.ts`.
- [ ] **Step 3: Implement.** Extend the unknown-var check to accept derived secret names; for a name matching `AI_REVIEW_REVIEWERS__<ID>__(PRIVATE_KEY|WEBHOOK_SECRET)` whose id is not in YAML, push a warning instead of throwing. Switch `resolveProviderCredentials` to `readSecret(providerKeySpec(p), env)` and the config's `providers` block. `api/debug.ts` adds `secrets: describeSecrets(...)` and a `reviewers` list with each reviewer's readiness (Task 7) and keeps the existing `hasXxx` fields. `src/config/docs.ts` adds a Secrets table (env name, aliases, permanence).
- [ ] **Step 4:** green, tail. Commit `feat(config): secret env names and multi-path aliases`.

---

### Task 7: Reviewer identity and config accessors

**Files:**
- Create: `src/reviewer-id.ts`, `src/reviewer-id.test.ts`, `src/reviewers.ts`, `src/reviewers.test.ts`
- Modify: `src/config.ts` (`getConfig`, `getOpenAIAppConfig` become wrappers), `src/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ReviewerId = string;
  export type LegacyProvider = "anthropic" | "openai";
  export function legacyProviderOf(id: ReviewerId): string;        // claude to anthropic, codex to openai, else id
  export function reviewerFromLegacy(identity: string): ReviewerId; // inverse
  export class UnknownReviewerError extends Error {}
  export class ReviewerNotReadyError extends Error { readonly reviewerId: string; readonly missing: string[] }
  export type ReadinessMode = "hosted" | "cli";
  export interface Readiness { ready: boolean; missing: string[] }
  export function listReviewerIds(): ReviewerId[];
  export function reviewerProviders(config: Config, id: ReviewerId): ProviderName[]; // every provider across tiers and skills
  export function reviewerReadiness(id: ReviewerId, mode: ReadinessMode, env?: Env): Readiness;
  export function getReviewerAppConfig(id: ReviewerId, opts?: GetConfigOptions): AppConfig;
  export function logReviewerReadiness(env?: Env): void; // one line per enabled, not-ready reviewer, once per cold start
  ```
- `AppConfig` gains `reviewer: ReviewerId`, `appSlug?: string` and keeps `provider` until Task 9. `agentConcurrency` is `reviewer.concurrency ?? review.agentConcurrency`. `reviewCommentPrefix` is `reviewer.commentPrefix ?? "${id}-review-bot"`.
- Readiness: hosted needs app id, private key, a webhook secret (own, else shared) and an API key for every provider in `reviewerProviders`; cli needs app id and private key, plus a key only for providers other than anthropic and openai (those are decided by auth resolution). A present PKCS#1 key still throws the existing `validatePrivateKey` error, because it is a config mistake, not an absent secret.
- `getConfig()` is `getReviewerAppConfig("claude")` and `getOpenAIAppConfig()` is `("codex")`; their missing-variable messages stay `Missing required environment variable: GITHUB_APP_ID` and so on (first alias name for claude and codex, the derived name for any other id).

- [ ] **Step 1: Write failing tests.**
  - `reviewer-id.test.ts`: round trips for `claude`, `codex`, `gemini`; `reviewerFromLegacy("gemini")` is `gemini`.
  - `reviewers.test.ts`: `unknown id throws UnknownReviewerError` including `"__proto__"` and `"constructor"` (use `Object.hasOwn`); `a disabled reviewer with credentials is not ready`; `missing only the webhook secret lists exactly that` for hosted but is ready for cli; `shared github.webhookSecret satisfies a reviewer with no own secret`; `zero enabled reviewers: listReviewerIds still lists, logReviewerReadiness logs nothing and does not throw`; `logReviewerReadiness logs one line per not-ready enabled reviewer and a second call logs nothing`; `a reviewer using a google tier needs the google key hosted, not cli for anthropic`; `getReviewerAppConfig("gemini") returns concurrency and prefix from YAML`.
  - `config.test.ts` keeps every existing assertion passing unchanged.
- [ ] **Step 2: Run (red).** `pnpm test src/reviewer-id.test.ts src/reviewers.test.ts src/config.test.ts`.
- [ ] **Step 3: Implement.** `src/config.ts` keeps `QcAppConfig`, `getQcAppConfig`, `validatePrivateKey`, the parse helpers and re-exports `AppConfig`. Remove `getRequiredEnv` use for reviewers in favour of `readSecret`.
- [ ] **Step 4:** green, tail. Commit `feat(config): getReviewerAppConfig with readiness`.

---

### Task 8: Marker compatibility

**Files:**
- Modify: `src/review-metadata.ts`, `src/review.ts` (`formatReviewBody`, `parseReviewMetadata`, the `ownReviewOf` caller), `src/ledger/github.ts`, `src/resolve-threads.ts`, `src/testing.ts`; tests `src/review-metadata.test.ts`, `src/review.test.ts`, `src/ledger/github.test.ts`, `src/baseline.test.ts`

**Interfaces:**
- `isOwnReview(body, o: { commentPrefix: string; reviewer: string }): boolean`. Rule: the `### <prefix>` heading must be present; then a `reviewer` marker decides by equality; else a `provider` marker decides by `reviewerFromLegacy(provider) === o.reviewer`; else (legacy body with neither) it is ours. A `reviewer` marker wins over a conflicting `provider` marker.
- `FormatReviewBodyOptions.provider` becomes `reviewer: ReviewerId`; the block writes `ai-review:reviewer=<id>` then `ai-review:provider=<legacyProviderOf(id)>`, adjacent. `ReviewMetaParsed` adds `reviewer: string` (marker, else `reviewerFromLegacy(provider)`) and keeps `provider`.
- Until Task 9, callers pass `reviewerFromLegacy(context.provider)`.

- [ ] **Step 1: Write failing tests.**
  - `review-metadata.test.ts`: body with only `provider=anthropic` is own for `claude`, not for `codex`, not for `gemini`; body with `reviewer=gemini` and `provider=gemini` is own for `gemini` only; `reviewer=claude` plus a stale `provider=openai` is own for `claude`; no marker is own for any id; a quoted marker outside the block is ignored.
  - `review.test.ts`: `formatReviewBody` output contains both markers inside the contiguous block and `readMetadataBlock` returns both; `parseReviewMetadata` of a fixture written by the old formatter (provider only) returns `reviewer: "claude"`.
  - Compatibility, using old-formatter fixture bodies (copy a real posted body shape from an existing test): a same-head re-review is skipped as already reviewed; `deriveBaseline` carries the prior blockers; the ledger rebuild keeps the settled thread; a watch restart reviews the delta. Each as its own named test (`old review is recognised at the same head`, `carried blocker survives the marker change`, `restart reviews only the delta`).
- [ ] **Step 2: Run (red).** `pnpm test src/review-metadata.test.ts src/review.test.ts src/ledger src/baseline.test.ts src/resolve-threads.test.ts`.
- [ ] **Step 3: Implement** per Interfaces. `src/testing.ts` body builder gains a `reviewer` option and keeps `provider`.
- [ ] **Step 4:** green, tail. Commit `feat(review): reviewer marker with legacy provider compatibility`.

---

### Task 9: Reviewer replaces provider in runtime identity

**Files:**
- Modify: `src/config.ts`, `src/reviewers.ts`, `src/review.ts`, `src/github-app.ts`, `src/discards.ts`, `src/resolve-threads.ts`, `src/ledger/github.ts`, `src/ledger/live.ts`, `src/feedback/{types,store,persist,poll,reactions}.ts`, `src/improve/{capture,drain,findings}.ts`, `src/agent-log.ts`, `src/audit.ts`, `src/cli.ts`, `src/watch.ts`, `src/scheduler.ts` (field only), their tests

**Interfaces:**
- `AppConfig.provider` is removed; `reviewer` stays. `ReviewContext.provider` becomes `reviewer: ReviewerId`. `Discard.provider` becomes `Discard.reviewer`. `Provider` in `src/feedback/types.ts` and `src/replay/types.ts` becomes `ReviewerId`.
- Persisted legacy forms stay byte-identical for Claude and Codex: claim key `review-claim:${legacyProviderOf(reviewer)}:${owner}/${repo}#${pr}@${sha}`; quota and rate-limit comment markers use `legacyProviderOf`; feedback KV keys `fb:cmt:${legacyProviderOf(reviewer)}:${id}`; `findingNaturalKey({provider: legacyProviderOf(reviewer), ...})` keeps its `provider` parameter name.
- `PostedCommentRecord` and `FeedbackEvent` gain `reviewer: ReviewerId` and keep `provider` (the legacy form, written for one release). `normalizeRecord(raw): PostedCommentRecord` fills `reviewer` from `reviewerFromLegacy(provider)` when absent.
- `agent-log.ts` records `provider` as the selection's provider name and adds `reviewer`.
- The Claude and Codex pair files (`src/audit.ts`, `src/cli.ts`, `src/gate/*`, `src/mistakes/*`, `src/auth.ts`) replace their inline `"anthropic" | "openai"` with `LegacyProvider`; behavior unchanged.

- [ ] **Step 1: Write failing tests.**
  - `review.test.ts`: `claim key for claude is byte-identical to the old key` (assert the exact string with `anthropic`); `claim key for a second reviewer on the same provider differs` (two reviewers `claude` and `claude-lite` on anthropic produce different keys, so neither suppresses the other).
  - `github-app` tests: quota-exhausted comment marker for `claude` is the old string; for `gemini` it embeds `gemini`.
  - `feedback/store.test.ts`: a record stored before the change (only `provider: "openai"`) is read back with `reviewer: "codex"` and found by the same KV key; two reviewers on one provider get distinct `fb:cmt` keys.
  - `improve/findings.test.ts`: `findingNaturalKey` for `claude` is unchanged; for `claude-lite` differs from `claude`.
  - `discards` and `capture` tests: the persisted discard row carries `provider: legacyProviderOf(reviewer)`.
- [ ] **Step 2: Run (red).** `pnpm test src/review.test.ts src/github-app.test.ts src/feedback src/improve src/discards.test.ts src/watch.test.ts`.
- [ ] **Step 3: Implement** the rename mechanically with `rg -n 'provider'` over the files above. Use the typechecker to find leftovers; any remaining `"anthropic" | "openai"` in a runtime-identity position is a bug, in a CLI-pair position is a `LegacyProvider`.
- [ ] **Step 4:** green, tail (full `pnpm test`, since this touches many suites). Commit `refactor: reviewer id replaces provider as identity`.

---

### Task 10: Own logins from appSlug

**Files:**
- Modify: `src/improve/backfill.ts`, `src/improve/backfill.test.ts`, `src/review.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function botLoginsToReviewer(reviewers: Config["reviewers"]): Record<string, ReviewerId>; // `${appSlug}[bot]` to id, for reviewers with an appSlug
  ```
  It replaces the `BOT_PROVIDERS` constant. `attributeProviderForComment` takes the set of active reviewer ids and also matches a mention of a reviewer's `commentPrefix`, keeping its existing `anthropic` and `openai` text matching for claude and codex.

- [ ] **Step 1: Write failing tests.** With the real `.ai-review.yaml`: `botLoginsToReviewer` maps `anthropicreviewbot[bot]` to `claude`, `codexreviewbot[bot]` to `codex`, `gemini-review-bot[bot]` to `gemini`; a reviewer with no appSlug is absent; a comment by `gemini-review-bot[bot]` is attributed to `gemini` in `backfill`; an unknown bot is not attributed. In `review.test.ts`: a review whose block says `reviewer=gemini` is a sister review for `claude` (included in the dedup prompt at the same head, excluded at another head).
- [ ] **Step 2: Run (red).** `pnpm test src/improve/backfill.test.ts src/review.test.ts`.
- [ ] **Step 3: Implement.** Keep behavior for existing logins identical (their slugs now come from YAML).
- [ ] **Step 4:** green, tail. Commit `feat(improve): derive own bot logins from appSlug`.

---

### Task 11: Per-skill models, runOn, mixed-model cost

**Files:**
- Modify: `src/router.ts`, `src/models.ts`, `src/concurrency.ts`, `src/review.ts`, `src/audit.ts` (call site), `src/replay/live-wiring.ts` (call site); tests beside each

**Interfaces:**
- Produces:
  ```ts
  export function resolveSkillModel(config: Config, reviewerId: string, skill: string, tier: ReviewTier): { provider: ProviderName; model: string; effort?: Effort };
  export function shouldRunOnTier(config: Config, reviewerId: string, tier: ReviewTier): boolean; // runOn absent means every tier
  export function routeReviewerModel(context: RouterContext, reviewerId: ReviewerId): { selection: ModelSelection; tier: ReviewTier };
  export function routeModel(context: RouterContext, provider: LegacyProvider): ModelSelection; // unchanged signature, wraps the above
  export function sumCost(byModel: ReadonlyMap<string, TokenUsage>): number | undefined; // undefined when any model has no price
  export function modelLabel(models: readonly string[]): string; // unique, sorted, joined with ","
  export async function mapWithConcurrencyByGroup<T, R>(items: readonly T[], groupOf: (item: T) => string, limit: number, fn: (item: T, index: number) => Promise<R>, opts?: { onBeforeEach?: (index: number) => Promise<void> }): Promise<R[]>; // groups run one after another in first-appearance order, each with serialFirst; results in input order
  ```
- `resolveSkillModel` order: `skills.<skill>.<tier>`, then `skills.<skill>` (its `model`/`effort`), then `tiers.<tier>`. Skill is the base name without `.md`.
- In `buildReview`: after routing, `if (!shouldRunOnTier(...)) return null` with one log line; each agent dispatch uses `resolveSkillModel`; the first-agent-alone pass uses `mapWithConcurrencyByGroup` keyed by model id; ok outcomes carry `model`; total cost is `sumCost` over per-model usage including the summary call (under the base selection's model); the footer and `ai-review:model` marker use `modelLabel`.

- [ ] **Step 1: Write failing tests.**
  - `router.test.ts`: the three-level resolution order with one case per level; equivalence for the real YAML: for every skill and tier, `resolveSkillModel` equals today's `routeModel` result for claude and codex; `shouldRunOnTier` true when `runOn` is absent, false for a tier outside it; `classifyTier` is not consulted by `shouldRunOnTier`.
  - `concurrency.test.ts`: with groups `[a,b,a,b]` and a recording `fn`, group `a` finishes entirely before group `b` starts, each group's first call completes before its second starts, results are in input order, and a single group behaves exactly like `mapWithConcurrency` with `serialFirst`.
  - `models.test.ts`: `sumCost` with two models priced via pins equals the sum of `computeCost` per model; one unpriced model makes it `undefined`; an empty map is `0`.
  - `review.test.ts`: `a reviewer with runOn [complex, deep] posts nothing on a normal PR`; `a skill override on another model prices that agent with its own model` (assert the cost against hand-computed pins); `one distinct model means one serial warm-up (same call order as today)`; `concurrency override: reviewers.x.concurrency 1 serialises agents`.
- [ ] **Step 2: Run (red).** `pnpm test src/router.test.ts src/concurrency.test.ts src/models.test.ts src/review.test.ts`.
- [ ] **Step 3: Implement.** Keep the single-model path identical in call order so the existing agent-order tests pass unmodified.
- [ ] **Step 4:** green, tail. Commit `feat(review): per-skill models, runOn and per-model cost`.

---

### Task 12: One webhook route

**Files:**
- Create: `src/webhook-handler.ts`, `src/webhook-handler.test.ts`, `api/github/reviewer/[id].ts`, `vercel.test.ts`
- Modify: `src/github-app.ts`, `api/github/webhook.ts`, `api/github/webhook-openai.ts`, `vercel.json`

**Interfaces:**
- Produces:
  ```ts
  export function getReviewerGitHubApp(id: ReviewerId): App; // memoized per id; throws UnknownReviewerError or ReviewerNotReadyError
  export function createReviewerWebhookHandler(fixedId?: ReviewerId): (req: VercelRequest, res: VercelResponse) => Promise<void>;
  ```
  `getGitHubApp` and `getOpenAIGitHubApp` are removed. `registerHandlers(app, () => getReviewerAppConfig(id))`.
- Handler order: 405 for non-POST; resolve the id (`fixedId`, else a single string `req.query.id`); unknown id (not an own key of `config.reviewers`, or not matching `^[a-z][a-z0-9-]*$`, or an array) gives 404 before any header, body or signature work; configured but disabled or not ready gives 503 naming the missing item; then the existing header check, signature verify and `waitUntil` flow unchanged.
- `api/github/webhook.ts` is `export default createReviewerWebhookHandler("claude")`; `webhook-openai.ts` uses `"codex"`.
- `vercel.json` `functions`: drop the four explicit `api/github/*` entries, add `"api/github/**/*.ts": { "maxDuration": 300 }`.

- [ ] **Step 1: Write failing tests** (fake req/res as in `api/github/webhook-qc.test.ts`).
  - `unknown id returns 404 and never reads the body` (spy on `readRawBody`); the same for `__proto__`, `constructor`, `Claude`, a 300-character id, and `query.id = ["claude","codex"]`.
  - `disabled reviewer returns 503` (gemini with credentials set); `enabled reviewer missing its private key returns 503 and does not throw`.
  - `legacy routes map to claude and codex` (the app looked up for each wrapper has the matching reviewer's app id).
  - `valid signature returns 202` and `bad signature returns 400` for `gemini` once enabled with a test key and a shared webhook secret.
  - `getReviewerGitHubApp memoizes per id and uses the shared secret when the reviewer has none`.
  - `vercel.test.ts`: the `api/github/**/*.ts` key exists with `maxDuration` 300, no explicit `api/github/webhook` entries remain, and `api/github/reviewer/[id].ts` exists.
- [ ] **Step 2: Run (red).** `pnpm test src/webhook-handler.test.ts vercel.test.ts src/github-app.test.ts`.
- [ ] **Step 3: Implement.** Note `api/github/webhook-qc.test.ts` already sits under the new glob; it is not a handler and is ignored by the build today, so leave it.
- [ ] **Step 4:** green, tail. Commit `feat(api): unified reviewer webhook route`.

---

### Task 13: QStash message, review-run, feedback cron

**Files:**
- Modify: `src/scheduler.ts`, `api/github/review-run.ts`, `api/cron/poll-feedback.ts`, `src/github-app.ts` (publisher), `src/feedback/poll.ts`; tests `src/scheduler.test.ts`, `api/github/review-run.test.ts` (create if absent), `src/feedback/poll.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ReviewRunMessage { reviewer?: ReviewerId; provider?: string; owner: string; repo: string; pullNumber: number; headSha: string; action: string; installationId: number }
  export function reviewerOfMessage(message: ReviewRunMessage): ReviewerId | null; // reviewer, else reviewerFromLegacy(provider) when provider is anthropic or openai, else null
  ```
- The publisher writes `reviewer` and `provider: legacyProviderOf(reviewer)`, so an old instance that receives a Claude or Codex message still accepts it. The dedup id is built from `reviewer`.
- `review-run`: invalid JSON gives 400; `reviewerOfMessage` null gives 400 `Invalid or missing reviewer`; a valid shape that is not a configured reviewer gives 404; a configured reviewer that is not ready gives 503; then signature verification and `runScheduledReview` as today.
- `poll-feedback`: `getOctokit(reviewer, installationId)` uses `getReviewerGitHubApp(reviewer)`; a record whose reviewer is unknown or not ready is skipped with one log line and does not stop the other records.

- [ ] **Step 1: Write failing tests.** `reviewerOfMessage` for provider-only (`openai` gives `codex`), reviewer-only, both, neither, and `provider:"gemini"` without reviewer (null); `dedupId` contains no `:` and differs per reviewer; `scheduleReview` publishes both fields for claude and `provider: "gemini"` for gemini; `review-run` cases listed above (an old-shape message verifies and runs as `claude`); `poll` skips an unready reviewer's record and still processes the next.
- [ ] **Step 2: Run (red).** `pnpm test src/scheduler.test.ts api/github/review-run.test.ts src/feedback/poll.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** green, tail. Commit `feat(scheduler): carry reviewer id in review-run messages`.

---

### Task 14: CLI watch and replay fixtures

**Files:**
- Modify: `src/watch.ts`, `src/cli.ts` (`cmdWatch`), `src/replay/{types,command,record,live-wiring,testkit}.ts`; tests `src/watch.test.ts`, `src/replay/command.test.ts`, `src/replay/fixtures.test.ts` (create if absent)

**Interfaces:**
- `ProviderTarget` becomes `ReviewerTarget { reviewer: ReviewerId; app; installationId; config: AppConfig }`; `WatchOptions.resolveAuthFor: (reviewer: ReviewerId) => Promise<ResolvedAuth | undefined>` (undefined means API key through the registry).
- `export function reviewerAuthProvider(config: Config, id: ReviewerId): LegacyProvider | null` returns the sole provider when every model of the reviewer is anthropic or openai and they agree, else `null`. Subscription auth applies only when it is non-null; otherwise `undefined` auth.
- `cmdWatch` accepts `--reviewer <id>` (repeatable) and keeps `--provider anthropic|openai` as an alias. Default targets are the enabled reviewers that are CLI-ready (`reviewerReadiness(id, "cli")`), which is Claude and Codex under the shipped config. Zero targets exits with `fatal("no enabled reviewer is ready for the CLI")`.
- Replay: the fixture file keeps `provider` on disk and gains optional `reviewer`; `fixtureReviewer(f) = f.reviewer ?? reviewerFromLegacy(f.provider)`; `--record` and `--live` accept `--reviewer <id>` (and `--provider`), record both fields; `live-wiring` routes with `routeReviewerModel` and picks auth by `reviewerAuthProvider`.

- [ ] **Step 1: Write failing tests.**
  - `watch.test.ts`: `circuit breaker state is per reviewer`; `a google reviewer gets undefined auth and never calls resolveSubscriptionAuth`; `a reviewer whose models span anthropic and openai gets undefined auth`.
  - `command.test.ts`: `--reviewer gemini` parses; `--provider openai` parses to reviewer `codex`; `--reviewer` and `--provider` together exit 2.
  - `fixtures.test.ts`: every existing fixture loads and maps `anthropic` to `claude`, `openai` to `codex`; a fixture with `reviewer: "gemini"` and `provider: "gemini"` loads.
  - `reviewerAuthProvider` cases: claude gives `anthropic`, codex gives `openai`, gemini gives `null`.
- [ ] **Step 2: Run (red).** `pnpm test src/watch.test.ts src/replay`.
- [ ] **Step 3: Implement.** `review`, `audit`, `gate` and `ready` are not touched beyond `LegacyProvider` from Task 9.
- [ ] **Step 4:** green, tail. Commit `feat(cli): watch and replay take a reviewer id`.

---

### Task 15: DB expand step

**Files:**
- Modify: `src/improve/db/schema.ts`, `src/improve/db/repo.ts`, `src/improve/db/repo.fixtures.ts`, `src/improve/capture.ts`, `src/improve/drain.ts`, `src/improve/qc.ts`, `src/improve/backfill.ts`; tests `src/improve/db/schema.test.ts`, `repo.test.ts`, `repo.integration.test.ts`
- Create: `src/improve/db/migrations/0004_<name>.sql` plus the snapshot and journal entry, generated by `pnpm db:generate --name reviewer_expand` (it reads only the schema and touches no database)

**Interfaces:**
- Schema: the `provider` pgEnum is removed and the four `provider` columns become `text("provider").notNull()`; each table gains `reviewer: text("reviewer")` (nullable). The unique index `finding_discards_uq` and `provider` indexes stay; add non-unique `*_reviewer_idx` indexes on `(reviewer, owner, repo, pr)` for the three tables that have a PR index.
- Migration, hand-edited after generation, in this order: add the four `reviewer` columns; `UPDATE <table> SET reviewer = CASE provider::text WHEN 'anthropic' THEN 'claude' WHEN 'openai' THEN 'codex' ELSE provider::text END WHERE reviewer IS NULL` for each table; alter the columns to `text`; drop the `provider` type; create the new indexes.
- Produces in `repo.ts`:
  ```ts
  export function identityColumns(reviewer: ReviewerId): { reviewer: string; provider: string }; // provider is legacyProviderOf(reviewer)
  export const reviewerExpr: SQL; // coalesce(reviewer, case provider when 'anthropic' then 'claude' when 'openai' then 'codex' else provider end)
  ```
  Every insert into the four tables spreads `identityColumns(...)`. Every read of `provider` (`listFindingsForPr` and any other found by `rg -n 'provider' src/improve`) selects `reviewerExpr as reviewer` instead; `listFindingsForPr` returns `reviewer` in place of `provider`, and `qc.ts` calls `judgeSelection(legacyProviderOf(finding.reviewer))`.
- Out of scope: `NOT NULL` on `reviewer`, dropping `provider`, moving the unique index (the contract step, a later PR). Do not run `pnpm db:migrate` or apply the SQL anywhere.

- [ ] **Step 1: Write failing tests.**
  - `repo.test.ts` (pg-mem): `new writes store reviewer and the legacy provider` for `claude` (`anthropic`) and `gemini` (`gemini`); `provider accepts a value outside the old enum`; `an old-shape row inserted after the backfill (provider only, reviewer NULL) is read back as claude` through `listFindingsForPr`; `backfill statements set reviewer on pre-existing rows` (insert rows through raw SQL before running the backfill statements, run them, assert); `discards: the same reviewer twice yields one row, two reviewers on one provider yield two rows`.
  - `schema.test.ts`: the table definitions expose `reviewer` and a text `provider`.
- [ ] **Step 2: Run (red).** `pnpm test src/improve`.
- [ ] **Step 3: Implement** the schema and repo changes, then run `pnpm db:generate --name reviewer_expand` and hand-edit the SQL to the order above. If pg-mem rejects `ALTER COLUMN ... TYPE` or `DROP TYPE`, keep the statements in the migration, exclude only those statements in `testing.ts` with a note naming `repo.integration.test.ts` as the real-Postgres check, and run that integration test if a `DATABASE_URL` for a scratch database is available (never the production one).
- [ ] **Step 4:** green, tail. Commit `feat(improve): expand corpus tables with a reviewer column`. In the PR body state that the migration is written and not applied, and that applying it needs an explicit go-ahead; until it is applied, `IMPROVE_ENABLED` must stay off for any reviewer other than claude and codex (the old enum rejects other values, and capture failures are logged, not surfaced).

---

### Task 16: Docs, config file, Gemini left off

**Files:**
- Create: `docs/adding-a-reviewer.md`
- Modify: `.ai-review.yaml`, `.env.example`, `CLAUDE.md`, `docs/configuration.md` (generated), the docs sidebar if `docs/.vitepress/config.*` lists pages

**Interfaces:** none.

- [ ] **Step 1: Write the failing check.** Add `src/config/docs-reviewer.test.ts`: the generated Secrets table lists `AI_REVIEW_REVIEWERS__<ID>__PRIVATE_KEY`, `AI_REVIEW_REVIEWERS__<ID>__WEBHOOK_SECRET`, `AI_REVIEW_PROVIDERS__GOOGLE__API_KEY` and `AI_REVIEW_GITHUB__WEBHOOK_SECRET`; and the repo's `.ai-review.yaml` has `reviewers.gemini.enabled === false`. Run `pnpm test src/config/docs-reviewer.test.ts` (red until the docs generator and YAML comment are updated).
- [ ] **Step 2: Update `.ai-review.yaml`.** Replace the "Inert until slice 2" comment above `gemini` with one line: enable only after the GitHub App exists and `ai-review replay --live --max-cost <usd>` shows an acceptable false-positive rate and cost. Keep `enabled: false`.
- [ ] **Step 3: Write `docs/adding-a-reviewer.md`**, in this order: add the YAML entry; create the GitHub App (webhook URL `<PUBLIC_URL>/api/github/reviewer/<id>`, same permissions and events as the Claude App); set `AI_REVIEW_REVIEWERS__<ID>__PRIVATE_KEY`, `__WEBHOOK_SECRET` (or the shared `AI_REVIEW_GITHUB__WEBHOOK_SECRET`), the app id, and the provider key; `pnpm config:check`; `ai-review replay --live --max-cost <usd>`; flip `enabled: true`; what happens when a secret is missing (one log line, 503). Then run the `no-ai-slop` skill in edit mode and the `humanizer` skill on the result, per the repo owner's writing rules for docs.
- [ ] **Step 4: Update `CLAUDE.md`** (request flow now shows `POST /api/github/reviewer/[id]` with the two legacy wrappers and the `reviewer` field on the QStash message; key files table gains `src/providers/*`, `src/reviewers.ts`, `src/reviewer-id.ts`, `src/skill-names.ts`; the `isOwnReview` row describes the reviewer marker plus the legacy provider marker; the KV claim key note says the prefix is the legacy identity for claude and codex; the env section lists the new aliases) and `.env.example` (derived secret names next to the legacy ones, standard provider key names marked permanent).
- [ ] **Step 5: Regenerate and verify.** `pnpm docs:config` (Bun), then `pnpm config:check`, then `AI_REVIEW_REVIEWERS__GEMINI__PRIVATE_KEY=x pnpm config:check` (passes, warns nothing), then `AI_REVIEW_REVIEWERS__GHOST__PRIVATE_KEY=x pnpm config:check` (passes with a warning naming `ghost`), then `bash scripts/pack-smoke.sh`. Finish with the full `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] **Step 6: Commit** `docs: how to add a reviewer, generated config reference`. Then open the PR with `gh pr create` per the repo template, noting for the owner: the DB migration is written and not applied; Gemini is off until a GitHub App exists and a replay run passes; the old `provider` field, column and marker stay for one release; `REVIEW_COMMENT_PREFIX` now warns as deprecated.

---

## Self-review

- **Spec coverage.** Section 3: reviewer fields (Task 5), secrets and webhook fallback (6), disabled-not-crash and zero reviewers (7, 12), one route and 404/503 and wrappers and glob (12), QStash carries id and accepts missing (13), accessors (7, 12), data model and identity in KV, ledger, feedback (9), peers from appSlug (10), markers (8), expand migration and old-writer test and fixtures (14, 15), Gemini off plus Flash-Lite structured-output check (3, 16). Section 2: registry (1), effort per provider and capability failure at load (2, 5), skills order and skill-name validation (5, 11), auth binding (1, 4), per-model warm-up (11). Section 1: derived secret names, provider-key fallbacks, deprecated names, generated docs (6, 16). Section 8: env overlay on maps (6), provider and key validation per mode (7), in-flight messages (13), expand/contract (15). Deferred and ruled: `qc:` block, per-reviewer `roles`.
- **Type consistency.** `ReviewerId`, `LegacyProvider`, `ProviderName`, `legacyProviderOf`, `reviewerFromLegacy`, `getReviewerAppConfig`, `getReviewerGitHubApp`, `routeReviewerModel`, `resolveSkillModel`, `reviewerReadiness`, `identityColumns` and `reviewerExpr` carry the same names and signatures wherever later tasks consume them. `AppConfig.provider` exists only between Tasks 7 and 9.
- **Proportion.** Signatures, test names and assertions throughout; bodies appear nowhere.
