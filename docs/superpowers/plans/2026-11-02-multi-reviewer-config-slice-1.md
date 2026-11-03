# Multi-reviewer YAML config, slice 1: config system, model routing, pricing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard-coded tier maps, prices, tier thresholds and behavior env parsing with one validated YAML config plus a derived-name env overlay, with Claude and Codex behaving exactly as today.

**Architecture:** A zod schema (`src/config/schema.ts`) defines every non-secret setting. `config/ai-review.yaml` holds the values. A loader applies YAML, then env (derived names and a deprecated-alias table), validates, and freezes. `router.ts`, `models.ts` and `config.ts` read the frozen tree. Hosted credentials and GitHub App secrets stay on their current env names in this slice.

**Tech Stack:** TypeScript ESM, zod 4, `yaml` (new dependency), vitest, biome, pnpm, Bun for the docs script.

**Spec:** [docs/superpowers/specs/2026-11-02-multi-reviewer-yaml-config-design.md](../specs/2026-11-02-multi-reviewer-yaml-config-design.md). This plan covers the spec's slice 1 only. Slices 2 to 5 get their own plans.

## Scope calls against the spec (slice 1 only)

These move work to later slices because nothing in slice 1 can reach it. Each is dead code until a second provider or a skill override exists.
- `skills:` overrides, the provider registry (`createProviderRegistry`), per-model `serialFirst`, and effort/thinking capability validation move to slice 2.
- Per-reviewer `roles:` and the top-level judge `roles:` move to slice 3.
- Secret env names for reviewers (`AI_REVIEW_REVIEWERS__<ID>__PRIVATE_KEY`) move to slice 2. Slice 1 builds the overlay mechanism and uses it for non-secret keys.
- `ModelSelection.provider` stays `"anthropic" | "openai"`. `routeModel(context, provider)` maps `anthropic` to reviewer `claude` and `openai` to reviewer `codex`.

## Global Constraints

Copied from the spec.
- Env name is `AI_REVIEW_` plus the key path, `__` between levels, camelCase to SCREAMING_SNAKE, hyphen to `_`.
- Precedence is env, YAML, default.
- Any env var with the `AI_REVIEW_` prefix that matches no schema path or documented alias is a startup error in every environment, naming the closest valid path.
- `AI_REVIEW_GATE_DIR`, `AI_REVIEW_MISTAKES_DIR` and `AI_REVIEW_LOG_FILE` stay permanent, documented aliases (not deprecated).
- Existing behavior vars (`REVIEW_ENABLED`, `AGENT_CONCURRENCY`, `REVIEW_*_DELAY_SECONDS` and the rest) keep working through an alias table; using one logs a deprecation warning once per cold start and names the replacement.
- Secrets never appear in YAML. The schema is strict, so a secret key in YAML is an unknown-key error.
- Claude and Codex keep working with no GitHub App or Vercel env changes.
- `src/auth.ts` and the CLI subscription path stay CLI-only; webhook paths never import it.
- Repo conventions: ESM with `.js` import extensions, named exports only, colocated vitest tests, biome, conventional commits. `pnpm typecheck`, `pnpm lint` and `pnpm test` must pass before each commit that touches code.
- Do not merge. The PR is opened for review and merged only after the owner approves.

## Review Focus

Input classes the spec implies but no task's tests would exercise on their own. Each has a test in the owning task.
1. Blank or whitespace env values (`REVIEW_DELAY_SECONDS=""`). Legacy code treats them as unset. The overlay must too. (Task 2)
2. Boolean spellings. Legacy `REVIEW_ENABLED` is off only for the exact string `false`. New rule: `true` or `false`, case-insensitive; blank is unset; anything else is a startup error. State this change in the PR body. (Task 2)
3. Both a deprecated alias and its derived name set, with different values. The derived name wins and a warning names both. (Task 2)
4. `config/ai-review.yaml` missing or unreadable at cold start. The error names the resolved path. (Task 3)
5. `routing.sensitivePathPatterns` empty, and `docExtensions` empty, must not crash `classifyTier`. (Task 4)

## File Structure

- Create `src/config/schema.ts`: zod schema, `Config` type, enums.
- Create `src/config/env.ts`: name derivation, overlay, alias table, unknown-var check.
- Create `src/config/load.ts`: YAML read, load pipeline, memoized frozen tree.
- Create `config/ai-review.yaml`: the values.
- Create `scripts/gen-config-docs.ts` and `scripts/pack-smoke.sh`.
- Modify `src/router.ts`, `src/models.ts`, `src/config.ts`, `api/debug.ts`, `package.json`, `.github/workflows/ci.yml`, `.env.example`, `CLAUDE.md`.
- Tests colocated: `src/config/schema.test.ts`, `env.test.ts`, `load.test.ts`; extend `router.test.ts`, `models.test.ts`, `config.test.ts`.

---

### Task 1: Config schema

**Files:**
- Create: `src/config/schema.ts`, `src/config/schema.test.ts`
- Modify: `package.json` (add `yaml` dependency via `pnpm add yaml`)

**Interfaces:**
- Produces:
  - `EffortSchema`, `TierSchema` (zod enums). Effort values: `none|low|medium|high|xhigh|max`. Tiers: `trivial|normal|complex|deep`.
  - `ConfigSchema` (strict zod object) and `type Config = z.infer<typeof ConfigSchema>`.
  - Top-level keys: `version: 1`; `review` (`enabled`, `delaySeconds`, `resyncDelaySeconds`, `command`, `customPrompt?`, `agentConcurrency`, `agentBudgetSeconds`, `diffBudgetChars`, `tier2Enabled`, `feedbackEnabled`); `improve` (`enabled`, `carrierEnabled`); `infra` (`publicUrl?`, `qstashUrl?`); `cli` (`gateDir?`, `mistakesDir?`, `logFile?`); `routing` (`sensitivePathPatterns`, `docExtensions`, `deepLabel`, `complexLines`, `trivialDocLines`); `models` (record keyed `provider/model`: `pricing{input,cachedInput,output}`, `refusalFallback` default false, `structuredOutput` `native|json` default `native`); `reviewers` (record keyed by id matching `^[a-z][a-z0-9-]*$`: `enabled` default true, `tiers{trivial,normal,complex,deep}` each `{model, effort?}`).
  - Defaults equal today's code: `delaySeconds` 0, `resyncDelaySeconds` 0, `command` `/ai-review`, `agentConcurrency` 4, `agentBudgetSeconds` 210, `diffBudgetChars` equals `DEFAULT_DIFF_BUDGET_CHARS` (import from `src/diff-pack.ts`), `tier2Enabled` true, `enabled` true, `feedbackEnabled` false, `improve.*` false.
  - Each leaf carries `.describe("...")`; the docs generator reads these.
  - Cross-check: every `reviewers.*.tiers.*.model` must exist in `models`.

- [ ] **Step 1: Write failing tests** in `src/config/schema.test.ts`. Names and assertions:
  - `accepts the minimal valid config` parses `{version:1, models, reviewers}` and fills defaults.
  - `rejects a tier model with no models entry` (error message contains the model id).
  - `rejects a bad reviewer id` (`Claude`, `a_b`).
  - `rejects a secret key in a reviewer` (`reviewers.claude.privateKey`) as an unknown key.
  - `rejects a bad model id` (`claude-sonnet-5-5` with no `provider/` prefix).
  - `rejects negative pricing`.
- [ ] **Step 2: Run** `pnpm vitest run src/config/schema.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Add the dependency and implement** `ConfigSchema` in `src/config/schema.ts` per the Interfaces block. Use `.strict()` on every object.
- [ ] **Step 4: Run** the same command. Expected: PASS. Run `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(config): add config schema`.

---

### Task 2: Env derivation and overlay

**Files:**
- Create: `src/config/env.ts`, `src/config/env.test.ts`

**Interfaces:**
- Consumes: `ConfigSchema`, `Config` (Task 1).
- Produces:
  ```ts
  export const ENV_PREFIX = "AI_REVIEW_";
  export type ValueSource = "env" | "alias" | "yaml" | "default";
  export function envNameForPath(path: readonly string[]): string;
  export interface AliasEntry { path: readonly string[]; deprecated: boolean }
  export const ENV_ALIASES: Readonly<Record<string, AliasEntry>>;
  export interface OverlayResult { value: unknown; sources: Record<string, ValueSource>; warnings: string[] }
  export class UnknownConfigEnvError extends Error {}
  export function applyEnvOverlay(raw: unknown, env: Readonly<Record<string, string | undefined>>): OverlayResult;
  ```
- `ENV_ALIASES` entries (name, path, deprecated):
  `REVIEW_ENABLED` review.enabled; `REVIEW_DELAY_SECONDS` review.delaySeconds; `REVIEW_RESYNC_DELAY_SECONDS` review.resyncDelaySeconds; `REVIEW_COMMAND` review.command; `CUSTOM_REVIEW_PROMPT` review.customPrompt; `AGENT_CONCURRENCY` review.agentConcurrency; `REVIEW_AGENT_BUDGET_SECONDS` review.agentBudgetSeconds; `REVIEW_DIFF_BUDGET_CHARS` review.diffBudgetChars; `REVIEW_TIER2_ENABLED` review.tier2Enabled; `FEEDBACK_ENABLED` review.feedbackEnabled; `IMPROVE_ENABLED` improve.enabled; `IMPROVE_CARRIER_ENABLED` improve.carrierEnabled; `PUBLIC_URL` infra.publicUrl; `QSTASH_URL` infra.qstashUrl (all deprecated true). `AI_REVIEW_GATE_DIR` cli.gateDir; `AI_REVIEW_MISTAKES_DIR` cli.mistakesDir; `AI_REVIEW_LOG_FILE` cli.logFile (deprecated false).
- Behavior: the overlay walks the schema's leaf paths. For each leaf it looks for the derived name, then the alias. Values are coerced by leaf type: boolean (`true`/`false`, case-insensitive), number (finite), string, enum, array/object as JSON. Blank or whitespace-only values count as unset. A value that fails coercion throws an error naming the env var and expected type. Derived name beats alias; if both are set, add a warning naming both. A set deprecated alias adds one warning naming its replacement. Any env key starting with `ENV_PREFIX` that is neither a derived name nor an alias throws `UnknownConfigEnvError` with the closest valid name (Levenshtein, or the first prefix match).

- [ ] **Step 1: Write failing tests** in `env.test.ts`:
  - `envNameForPath` returns `AI_REVIEW_REVIEWERS__GEMINI_LITE__TIERS__NORMAL__MODEL` for `["reviewers","gemini-lite","tiers","normal","model"]`, and `AI_REVIEW_REVIEW__AGENT_CONCURRENCY` for `["review","agentConcurrency"]`.
  - `derived name overrides yaml`, `yaml overrides default`.
  - `alias maps to its path and warns once` for `REVIEW_ENABLED=false`.
  - `derived name beats alias and warns about both`.
  - `blank value is treated as unset` for `REVIEW_DELAY_SECONDS="  "`.
  - `boolean accepts False and TRUE, rejects 0` (throws naming `REVIEW_ENABLED`).
  - `number rejects abc`.
  - `unknown AI_REVIEW_ var throws with a suggestion` for `AI_REVIEW_REVIEW__AGENT_CONCURENCY`.
  - `AI_REVIEW_GATE_DIR is accepted without a deprecation warning`.
  - `array values parse as JSON` for `routing.sensitivePathPatterns`.
- [ ] **Step 2: Run** `pnpm vitest run src/config/env.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/config/env.ts` per Interfaces. Build the leaf list by walking the zod schema once (shape traversal), not by hand-listing paths. Maps (`models`, `reviewers`) take overrides only for entries that exist in the raw YAML, per the spec.
- [ ] **Step 4: Run** the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(config): add derived env overlay and alias table`.

---

### Task 3: Loader, YAML file, packaging

**Files:**
- Create: `src/config/load.ts`, `src/config/load.test.ts`, `config/ai-review.yaml`, `scripts/pack-smoke.sh`
- Modify: `package.json` (`files` add `"config/"`), `.github/workflows/ci.yml` (run `bash scripts/pack-smoke.sh` in the lint-typecheck job)

**Interfaces:**
- Consumes: `ConfigSchema` (Task 1), `applyEnvOverlay` (Task 2).
- Produces:
  ```ts
  export interface LoadedConfig { config: Config; sources: Record<string, ValueSource>; warnings: string[] }
  export function loadConfig(opts?: { env?: Readonly<Record<string, string | undefined>>; yamlPath?: string }): LoadedConfig;
  export function getConfigTree(): Config;      // memoized, deep-frozen, uses process.env
  export function getLoadedConfig(): LoadedConfig;
  export function resetConfigForTests(): void;
  ```
  The default YAML path is `fileURLToPath(new URL("../../config/ai-review.yaml", import.meta.url))`. This resolves correctly from both `src/config/load.ts` and `dist/config/load.js`. Check against how `src/prompt.ts:13` resolves `skills/`.
- `src/config.ts` already exports `getConfig` (the GitHub App config), so the tree accessor is named `getConfigTree`.
- `config/ai-review.yaml` content: `version: 1`; `models` with the five current entries keyed `anthropic/claude-haiku-5-5`, `anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5-5`, `openai/gpt-6-luna`, `openai/gpt-6.1-sol`, using the rates in `src/models.ts` (`TOKEN_RATES`) for `input`/`output`. Set `cachedInput` to 0.1x input for Anthropic, and for OpenAI use 0.05x input (gpt-6-luna 0.005, gpt-6.1-sol 0.10). These cached rates are unverified guesses; the implementer confirms them on the provider pricing pages and notes any change in the PR. `refusalFallback: true` on `claude-opus-5-5` and `claude-sonnet-5-5`. `reviewers.claude` and `reviewers.codex` with the tier maps from `src/router.ts` (`CLAUDE_TIER_MAP`, `OPENAI_TIER_MAP`), prefixed model ids. `routing` with today's `SENSITIVE_PATH_PATTERNS`, `DOC_EXTENSIONS`, `deepLabel: deep-review`, `complexLines: 500`, `trivialDocLines: 20`. Keep the two explanatory comments from `router.ts` (Opus `high` not `xhigh`; Haiku long-context pricing) as YAML comments.

- [ ] **Step 1: Write failing tests** in `load.test.ts`:
  - `the real config/ai-review.yaml parses under ConfigSchema` (this is the CI gate for config typos).
  - `missing yaml throws an error that names the resolved path`.
  - `env overlay is applied after yaml` with an injected env.
  - `getConfigTree returns a frozen object` (assigning throws in strict mode).
  - `invalid yaml surfaces the schema issue path`.
- [ ] **Step 2: Run** `pnpm vitest run src/config/load.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/config/load.ts` and write `config/ai-review.yaml`. Add `"config/"` to `package.json` `files`.
- [ ] **Step 4: Write `scripts/pack-smoke.sh`**: `pnpm build`, `pnpm pack` into a temp dir, extract, run `node -e "import('./package/dist/config/load.js').then(m => m.loadConfig())"` from outside the checkout, exit non-zero on failure. Run it once locally. Expected: exit 0. Add the CI step.
- [ ] **Step 5: Run** `pnpm vitest run src/config` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(config): load, validate and freeze config from yaml and env`.

---

### Task 4: Router, models and pricing read the config

**Files:**
- Modify: `src/router.ts`, `src/models.ts`, `src/router.test.ts`, `src/models.test.ts`; callers of `computeCost` at `src/review.ts:2984`, `src/audit.ts:713`, `src/replay/live-wiring.ts:68`

**Interfaces:**
- Consumes: `getConfigTree()` (Task 3).
- Produces (router.ts):
  ```ts
  export function classifyTier(context: RouterContext, routing?: Config["routing"]): ReviewTier;
  export function resolveFinderModel(config: Config, reviewerId: string, tier: ReviewTier): { provider: string; model: string; effort?: Effort };
  export function routeModel(context: RouterContext, provider: "anthropic" | "openai"): ModelSelection; // signature unchanged
  ```
  `resolveFinderModel` splits `provider/model` into `provider` and bare `model`, so `ModelSelection` keeps its current shape. `routeModel` maps `anthropic` to `claude` and `openai` to `codex`.
- Produces (models.ts): `computeCost(usage: TokenUsage, model: string): number` with `TokenUsage` gaining optional `cachedPromptTokens?: number`. It finds the entry in `config.models` whose key equals `model` or ends with `/${model}`; an unknown model returns 0 as today. Cost is `(prompt - cached)/1e6 * input + cached/1e6 * cachedInput + completion/1e6 * output`.
- `REFUSAL_FALLBACK_MODELS` is removed; `reasoningProviderOptions` reads `refusalFallback` from the matching `models` entry.

- [ ] **Step 1: Write failing tests.** In `router.test.ts` add `routeModel matches the pre-config tier maps` with the old values inlined as a literal table (Claude: haiku low, sonnet medium, sonnet high, opus high; Codex: luna none, sol low, sol high, sol xhigh) over all four tiers and both providers, built via `classifyTier` inputs that hit each tier (a `deep-review` label, a sensitive path, over 500 lines, a docs-only change under 20 lines, and a plain change). Add `classifyTier handles empty sensitivePathPatterns and docExtensions` (passing a custom `routing`). Add `reasoningProviderOptions adds fallbacks only for refusalFallback models` for opus and sonnet versus haiku. In `models.test.ts` add `computeCost matches the old rates for all five models` (inline expected numbers from the old `TOKEN_RATES`) and `computeCost bills cached tokens at cachedInput`.
- [ ] **Step 2: Run** `pnpm vitest run src/router.test.ts src/models.test.ts`. Expected: new tests FAIL (or fail to compile).
- [ ] **Step 3: Implement** the changes in `router.ts` and `models.ts`; delete `CLAUDE_TIER_MAP`, `OPENAI_TIER_MAP`, `TOKEN_RATES`, `SENSITIVE_PATH_PATTERNS`, `DOC_EXTENSIONS` and `REFUSAL_FALLBACK_MODELS`.
- [ ] **Step 4: Thread cached tokens** into cost. At `src/review.ts` where per-agent usage is recorded (near lines 571 and 913) read the cached input token count from the AI SDK usage object. Check the field name against the installed `ai` types (`node_modules/ai`); in AI SDK 6 it is likely `usage.inputTokenDetails.cacheReadTokens` or `usage.cachedInputTokens`. Also check whether `inputTokens` already includes cache reads, and subtract them if so. Sum the new field where totals are built (near lines 2505 and 2971) and pass it to `computeCost` at line 2984, `src/audit.ts:713` and `src/replay/live-wiring.ts:68`. If the field cannot be read from the SDK usage object, leave it undefined, keep the cost behavior unchanged, and say so in the PR.
- [ ] **Step 5: Run** the full suite: `pnpm typecheck && pnpm lint && pnpm test`. Expected: PASS. Existing router, models and review tests must pass unchanged except where they reference the removed constants.
- [ ] **Step 6: Commit** `refactor(router): read tier maps, thresholds and prices from config`.

---

### Task 5: Behavior settings read the config

**Files:**
- Modify: `src/config.ts`, `src/config.test.ts`; any other file that reads one of the aliased env vars directly

**Interfaces:**
- Consumes: `getConfigTree()` (Task 3).
- Produces: `getConfig`, `getOpenAIAppConfig`, `parseAgentBudgetMs`, `parseDiffBudgetChars`, `parseAgentConcurrency`, `parseDelayMs` keep their exported names. `parseAgentBudgetMs`, `parseDiffBudgetChars` and `parseAgentConcurrency` take no arguments and return the config value (budget as ms). Returned `AppConfig` objects are field-for-field identical for unchanged env.
- Credentials stay as they are: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `OPENAI_APP_*`, `QC_APP_*`, QStash tokens and signing keys, KV and DB vars, and `REVIEW_COMMENT_PREFIX` / `OPENAI_REVIEW_COMMENT_PREFIX` (per-reviewer, slice 2).

- [ ] **Step 1: Find direct reads.** Run `rg -n "process\.env\.(REVIEW_|AGENT_CONCURRENCY|CUSTOM_REVIEW_PROMPT|FEEDBACK_ENABLED|IMPROVE_ENABLED|IMPROVE_CARRIER_ENABLED|PUBLIC_URL|QSTASH_URL|AI_REVIEW_)" src api` and list them in the task notes.
- [ ] **Step 2: Write failing tests** in `config.test.ts`:
  - `getConfig reproduces the legacy defaults with an empty env`, asserting each default listed under Task 1.
  - `REVIEW_ENABLED=false disables review` and `AGENT_CONCURRENCY=2 sets concurrency` (through the alias, with the deprecation warning captured).
  - `a malformed REVIEW_AGENT_BUDGET_SECONDS now throws` (documented behavior change; replaces the old fallback-to-default test).
  - `getOpenAIAppConfig still sets provider openai and its own comment prefix default`.
- [ ] **Step 3: Run** `pnpm vitest run src/config.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Rewire `src/config.ts` and the other direct reads from Step 1 (`CUSTOM_REVIEW_PROMPT`, `PUBLIC_URL`, `QSTASH_URL` consumers, the three `AI_REVIEW_*` CLI-local vars at `src/gate/store.ts:89`, `src/mistakes/log.ts:49` and `src/agent-log.ts:249`). Keep `validatePrivateKey` untouched.
- [ ] **Step 5: Run** `pnpm typecheck && pnpm lint && pnpm test`. Expected: PASS.
- [ ] **Step 6: Commit** `refactor(config): read behavior settings from the config tree`.

---

### Task 6: Auth is bound to the selected provider

**Files:**
- Modify: `src/models.ts`, `src/models.test.ts`

**Interfaces:**
- Consumes: `ResolvedAuth` (`src/auth.ts:36`, which already has `provider`), `ModelSelection`.
- Produces: `createAIModel(selection, auth?)` throws `Error("auth for <auth.provider> cannot be used with a <selection.provider> model")` when `auth` is given and `auth.provider !== selection.provider`. Signature unchanged.

- [ ] **Step 1: Write failing test** `createAIModel rejects a credential for a different provider` (API-key auth for `openai` with an `anthropic` selection) and `createAIModel accepts matching provider auth`.
- [ ] **Step 2: Run** `pnpm vitest run src/models.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the guard at the top of `createAIModel`.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(models): reject auth for a different provider`.

---

### Task 7: Check command, generated docs, debug endpoint, CI

**Files:**
- Create: `scripts/gen-config-docs.ts`, `docs/configuration.md` (generated)
- Modify: `package.json` scripts, `api/debug.ts`, `.github/workflows/ci.yml`, `.env.example`, `CLAUDE.md`

**Interfaces:**
- Consumes: `ConfigSchema` (Task 1), `ENV_ALIASES`, `envNameForPath` (Task 2), `loadConfig` (Task 3).
- Produces:
  - `pnpm config:check`: loads the real YAML with the current `process.env`; exits 0 and prints `ok` with the warning count, or exits 1 printing the error.
  - `pnpm docs:config`: runs `bun scripts/gen-config-docs.ts` and rewrites `docs/configuration.md`, a table with columns YAML path, env var, deprecated alias, type, default, description, built from the schema.
  - `api/debug.ts` returns `{ config: [{ path, value, source }], warnings }` for every non-secret leaf and keeps the existing `has*` credential fields unchanged.

- [ ] **Step 1: Write failing test** `src/config/describe.test.ts` for a new `describeConfig(loaded: LoadedConfig): Array<{ path: string; value: unknown; source: ValueSource }>` exported from `src/config/load.ts`: it lists every leaf of the tree, including `models` and `reviewers` entries by path, with its source. Run it. Expected: FAIL.
- [ ] **Step 2: Implement** `describeConfig`, `api/debug.ts`, the generator script and the two package scripts. Generate `docs/configuration.md` once and commit it.
- [ ] **Step 3: CI.** In the lint job add `pnpm config:check` and a stale-docs check: `pnpm docs:config && git diff --exit-code docs/configuration.md`.
- [ ] **Step 4: Docs.** Update `.env.example` and the "Environment variables" section of `CLAUDE.md` to point at `docs/configuration.md`, name the deprecated aliases, and describe the derived-name rule in two lines.
- [ ] **Step 5: Run** `pnpm config:check && pnpm docs:config && git diff --exit-code docs/configuration.md && pnpm typecheck && pnpm lint && pnpm test`. Expected: all pass, no diff.
- [ ] **Step 6: Commit** `feat(config): config:check, generated docs and debug report`.

---

## Self-review

- **Spec coverage (slice 1):** config system and env derivation (Tasks 1 to 3), models and pricing (Task 4), tier classification as config (Task 4), deprecated aliases and the CLI-local vars (Tasks 2 and 5), docs generation, `config:check`, `/api/debug` source reporting, packaging (Tasks 3 and 7), auth binding (Task 6), `computeCost` with cached tokens (Task 4). Moved out and recorded under "Scope calls".
- **Type consistency:** `getConfigTree` is the only config-tree accessor name; `ModelSelection` is unchanged; `computeCost` and `routeModel` keep their signatures.
- **Proportion:** each task names signatures, tests and spec values; bodies are left to the implementer.
