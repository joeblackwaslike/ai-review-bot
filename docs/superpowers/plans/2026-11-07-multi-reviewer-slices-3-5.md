# Multi-reviewer slices 3-5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable judge and per-reviewer roles (slice 3), live Edge Config overrides (slice 4) and per-repo override files (slice 5) to the YAML-driven reviewer config that PR #108 shipped.

**Architecture:** Roles resolve through one module (`src/roles.ts`) that every non-finder LLM call uses, with today's derivations as the defaults so behavior is unchanged until YAML says otherwise. Edge Config and repo files never mutate the frozen cold-start config. Each produces a derived, validated copy (Edge) or a restrictive-only `RepoOverrides` value (repo) that the hosted review path consumes.

**Tech Stack:** TypeScript ESM, zod 4, vitest, biome, `@vercel/edge-config` (new), `yaml`, Octokit.

**Spec:** `docs/superpowers/specs/2026-11-02-multi-reviewer-yaml-config-design.md` (sections 4, 6, 7, 8). Beads `ai-review-bot-dg4.2`, `.3`, `.4`.

## Global Constraints

- The hosted path stays inside the 210s agent budget. Direct provider calls add no network hop.
- `src/auth.ts` and the CLI subscription path stay CLI-only. Webhook paths never import them.
- Claude and Codex keep working with no GitHub App or Vercel env changes.
- An unknown `AI_REVIEW_*` env var is a hard startup error. An unknown or non-`live` Edge Config key is ignored and reported, never a crash.
- Precedence: Edge Config, env, YAML, default. Restrictive controls (reviewer or skill enabled, `runOn`, severity floor, sensitive patterns) combine monotonically across every layer and the repo file; a repo file can only stay at or below the deployment config.
- The repo file is read from the default branch, never the PR head.
- No database migration is added or applied in this work.
- Spec, plan and code land on one branch (`feat/multi-reviewer-slices-3-5`) and one PR. Merge only after Joe approves.
- Gates before every commit: `pnpm typecheck`, `pnpm lint`, `pnpm test`. After any schema change also run `pnpm docs:config` and commit the regenerated `docs/configuration.md`.
- Model for subagents is named on every dispatch (Sonnet 5.5 for implementers and task reviews, Opus 5.5 only for the final whole-branch review).

## Rulings (made while planning; the spec is silent or ambiguous)

- Top-level `roles:` also accepts `summary`, `triage`, `revalidate` as deployment-wide defaults, because spec section 8's precedence names `roles.<role>` for them. Judge-only roles (`verifier`, `qcJudge`, `classifier`) exist only at top level.
- `qcJudge` and `classifier` fall back to `DEFAULT_JUDGE` (`anthropic/claude-haiku-5-5`, effort `low`) when unset. That is today's classifier model and today's Anthropic QC model. Codex findings are now judged by that model too, as the spec's "same-provider rule goes away" implies.
- The verifier has no call site yet (epic `ai-review-bot-t0c`, D1). Slice 3 ships its resolver and tests only.
- "Raise severity floors" needs a deployment key that does not exist. Add `review.minSeverity` (`P3` default, allowed `P3|P2|P1`; P0 and P1 are never dropped, matching adaptive limits). Findings below the floor are dropped before merge and recorded as `ADAPTIVE_LIMIT` discards, so no enum migration is needed.
- For non-restrictive scalars (`review.customPrompt`, `review.command`) the repo file beats YAML but loses to env: it applies only when `sources[path]` is `yaml` or `default`.

## Review Focus

- A role pointing at a provider with no API key: the reviewer or role is disabled with a log line, the process does not crash.
- Edge Config returns a non-object, throws, or hangs: the cold-start config is used and the review proceeds.
- The repo file is malformed YAML, over 20 KB, a directory, or has unknown keys: the whole file is ignored, the review body carries a one-line note, the review still posts.
- The repo file sets `enabled: true` on a disabled reviewer, lowers `minSeverity`, or sets `runOn` outside the deployment's: no privilege gain.
- Env and Edge Config both set one live key: Edge wins. Edge sets a non-live key: ignored and listed in `/api/debug`.

## File Structure

- Create `src/roles.ts`, `src/config/live.ts`, `src/config/edge.ts`, `src/repo-config/schema.ts`, `src/repo-config/fetch.ts`, `src/repo-config/merge.ts`, `src/severity-floor.ts`, each with a colocated `.test.ts`.
- Modify `src/config/schema.ts`, `src/config/docs.ts`, `src/triage.ts`, `src/review.ts`, `src/improve/qc.ts`, `api/cron/improve.ts`, `src/reviewers.ts`, `src/github-app.ts`, `src/webhook-handler.ts`, `api/github/review-run.ts`, `api/debug.ts`, `src/router.ts`, `.ai-review.yaml`, `.env.example`, `CLAUDE.md`, `docs/configuration.md`, `docs/adding-a-reviewer.md`, the spec.

---

## Slice 3: roles

### Task 1: Role schema

**Files:** Modify `src/config/schema.ts`, `src/config/schema.test.ts`, `.ai-review.yaml`.

**Interfaces:**
- Produces: `Config["roles"]` with optional keys `summary`, `triage`, `revalidate`, `verifier`, `qcJudge`, `classifier`; `Config["reviewers"][id]["roles"]` with optional `summary`, `triage`, `revalidate`. A role choice is `{ model: "provider/model", effort?: Effort }`; `verifier` also takes `differentFrom?: "finder"` and `enabled: boolean` (default `true`).

- [ ] **Step 1: Write failing tests** in `schema.test.ts`: `accepts a reviewer roles entry`; `accepts top-level qcJudge and classifier`; `rejects an unknown role key under a reviewer` (e.g. `roles.verifier` under a reviewer fails); `rejects an effort the role's provider does not take` (reuse the existing `checkChoice` message `... do not take effort ...`); `rejects a role model with an unknown provider prefix`; `verifier accepts differentFrom finder and rejects any other value`.
- [ ] **Step 2: Run** `pnpm vitest run src/config/schema.test.ts`. Expected: the new tests FAIL (unrecognized key `roles`).
- [ ] **Step 3: Implement** `RoleChoiceSchema` (strict; `model` via `modelId`, `effort` via `EffortSchema.optional()`), a `ReviewerRolesSchema`, and a `RolesSchema` (top-level, `.default({})`, the verifier entry extends the choice with `differentFrom` and `enabled`). Add `roles` to `ReviewerSchema` (optional) and `ConfigSchema`. In `superRefine` run `checkChoice` for every role at `["reviewers", id, "roles", name]` and `["roles", name]`.
- [ ] **Step 4: Add to `.ai-review.yaml`** a top-level `roles:` with `qcJudge` and `classifier` set to `anthropic/claude-haiku-5-5` effort `low`, and no reviewer `roles` (defaults apply).
- [ ] **Step 5: Run** `pnpm vitest run src/config` then `pnpm docs:config`. Expected: PASS, docs regenerated.
- [ ] **Step 6: Commit** `feat(config): role entries for reviewers and judge roles`.

### Task 2: Role resolver with equivalence tests

**Files:** Create `src/roles.ts`, `src/roles.test.ts`.

**Interfaces:**
- Consumes: `cheapSelection(base: ModelSelection): ModelSelection` from `src/router.ts`; `splitModelId` from `src/providers/names.ts`; `Config`.
- Produces:
  - `type ReviewerRoleName = "summary" | "triage" | "revalidate"`
  - `const DEFAULT_JUDGE: ModelSelection`
  - `resolveReviewerRole(config: Config, reviewerId: string, role: ReviewerRoleName, finder: ModelSelection): ModelSelection`
  - `resolveJudgeRole(config: Config, role: "qcJudge" | "classifier"): ModelSelection`
  - `resolveVerifier(config: Config, finder: ModelSelection, configuredProviders: readonly ProviderName[]): ModelSelection | null`

- [ ] **Step 1: Write failing tests.**
  - Equivalence (the defaults): with a config that has no roles, `resolveReviewerRole(..., "summary", sel)` returns `sel` unchanged; `"triage"` and `"revalidate"` return `cheapSelection(sel)` for an anthropic, an openai and a google finder (assert exact `{provider, model, effort}`).
  - Precedence: reviewer role beats top-level role beats default, for each of the three roles.
  - `resolveJudgeRole` returns the configured entry, and `DEFAULT_JUDGE` (`anthropic`, `claude-haiku-5-5`, `low`) when unset.
  - `resolveVerifier`: returns `null` when `enabled: false`; returns `null` when `differentFrom: "finder"` and the only configured provider equals `finder.provider`; returns the configured model when a different provider is available; returns `null` when no `verifier` entry exists.
- [ ] **Step 2: Run** `pnpm vitest run src/roles.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the four exports. Split `provider/model` with `splitModelId`; the effort is copied only when present.
- [ ] **Step 4: Run** the file again. Expected: PASS. Then `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(roles): role resolver with today's derivations as defaults`.

### Task 3: Wire summary, triage and revalidate

**Files:** Modify `src/triage.ts`, `src/triage.test.ts`, `src/review.ts`, `src/review.test.ts`, and any other caller of `triageReReview` / `revalidateFindings` (find with `rg -n "triageReReview\(|revalidateFindings\(" src`).

**Interfaces:**
- Changes: `triageReReview(selection, ...)` and `revalidateFindings(selection, ...)` now take the already-resolved role selection. They stop calling `cheapSelection` internally.
- Consumes: `resolveReviewerRole` from Task 2.

- [ ] **Step 1: Write failing tests.** In `triage.test.ts`: `uses the selection it is given without cheapening it` (pass a non-cheap selection, assert `createAIModel` receives that exact selection) for both functions. In `review.test.ts`: `routes triage and revalidate through the triage and revalidate roles` (config with a reviewer `roles.triage` model different from the finder; assert the model id the triage call receives); `summary uses the summary role and bills under its provider/model id` (extends the existing summary billing test); `with no roles configured, triage still receives cheapSelection(finder)`.
- [ ] **Step 2: Run** `pnpm vitest run src/triage.test.ts src/review.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** In `triage.ts` delete the two `cheapSelection(selection)` lines and use `selection` directly. In `review.ts` after `routeReviewerModel` compute the three role selections with `resolveReviewerRole`, pass the triage selection to `triageReReview` (around line 2282), the revalidate selection to `revalidateFindings` (around line 2365), the summary selection to `generateSummary` (around line 3305), and bill the summary under `${summary.provider}/${summary.model}`. Update every other caller found by the `rg` above so its behavior is unchanged (wrap with `resolveReviewerRole` or `cheapSelection` as it did before).
- [ ] **Step 4: Run** `pnpm typecheck && pnpm vitest run src/triage.test.ts src/review.test.ts src/replay`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(review): resolve summary, triage and revalidate through roles`.

### Task 4: QC judge and classifier on top-level roles

**Files:** Modify `src/improve/qc.ts`, `src/improve/qc.test.ts`, `api/cron/improve.ts`, `src/reviewers.ts`, `src/reviewers.test.ts`.

**Interfaces:**
- Consumes: `resolveJudgeRole`. Removes `judgeSelection`, `QC_OPENAI_MODEL`, `QC_ANTHROPIC_MODEL` (update every importer found by `rg -n "judgeSelection|QC_(OPENAI|ANTHROPIC)_MODEL" src api`).
- Produces: `reviewerProviders(config, id)` now also returns the providers of that reviewer's `roles` models.

- [ ] **Step 1: Write failing tests.** `qc.test.ts`: `judges a codex finding with the configured qcJudge model` (config qcJudge set to `openai/gpt-6-luna`; assert `createAIModel` receives it for a `codex` finding, and the default Haiku when unset). `reviewers.test.ts`: `reviewerProviders includes providers used only by a role`; `a reviewer whose role provider has no key is not ready in hosted mode and names the missing key`.
- [ ] **Step 2: Run** the two files. Expected: FAIL.
- [ ] **Step 3: Implement.** `judgeFinding` calls `resolveJudgeRole(getConfigTree(), "qcJudge")`. `api/cron/improve.ts` passes `resolveJudgeRole(getConfigTree(), "classifier")` as `selection`. Extend `reviewerProviders` to include role models.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm vitest run src/improve src/reviewers.test.ts api`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(improve): qcJudge and classifier come from roles`.

### Task 5: Slice 3 docs

**Files:** Modify `docs/adding-a-reviewer.md`, `CLAUDE.md` (Key files row for `src/roles.ts`, test count), `docs/configuration.md` (regenerated).

- [ ] **Step 1:** Add a short "Roles" section to `docs/adding-a-reviewer.md` (precedence, defaults, the verifier having no consumer yet). Add the `src/roles.ts` row to the CLAUDE.md key-files table.
- [ ] **Step 2: Run** `pnpm docs:config && pnpm typecheck && pnpm lint && pnpm test`. Expected: all green.
- [ ] **Step 3: Commit** `docs: roles`.

---

## Slice 4: Edge Config live overrides

### Task 6: Live key registry

**Files:** Create `src/config/live.ts`, `src/config/live.test.ts`; modify `src/config/docs.ts`, `src/config/docs.test.ts`.

**Interfaces:**
- Produces: `LIVE_PATTERNS: readonly string[]` (dotted, `*` for a map key): `review.enabled`, `review.delaySeconds`, `review.resyncDelaySeconds`, `review.agentConcurrency`, `review.agentBudgetSeconds`, `review.diffBudgetChars`, `review.tier2Enabled`, `reviewers.*.enabled`, `reviewers.*.concurrency`, `roles.verifier.enabled`; `isLivePath(path: readonly string[]): boolean`.

- [ ] **Step 1: Write failing tests.** `isLivePath` is true for each pattern with a concrete reviewer id and false for `reviewers.claude.tiers.normal.model`, `reviewers.claude.appId`, `review.command`, `models.anthropic/claude-haiku-5-5.pricing.input`. `docs.test.ts`: `the generated table marks live settings` (assert the row for `review.enabled` carries a "Live" marker and `review.command` does not).
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** `live.ts` and add a "Live" column to the table in `docs.ts` using `isLivePath`. Run `pnpm docs:config`.
- [ ] **Step 4: Run** `pnpm vitest run src/config`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(config): mark live-overridable settings`.

### Task 7: Edge Config client and live overlay

**Files:** Create `src/config/edge.ts`, `src/config/edge.test.ts`; modify `package.json`, `pnpm-lock.yaml`.

**Interfaces:**
- Consumes: `isLivePath`, `envNameForPath` and the leaf coercion that `applyEnvOverlay` uses (reuse it; do not write a second coercer), `ConfigSchema`.
- Produces:
  - `interface LiveResult { config: Config; applied: string[]; ignored: { key: string; reason: string }[]; error?: string }`
  - `applyLiveOverrides(base: Config, edge: Readonly<Record<string, unknown>>): LiveResult`
  - `getEffectiveConfig(opts?: { now?: () => number; read?: () => Promise<unknown> }): Promise<LiveResult>`: reads Edge Config when `EDGE_CONFIG` is set, caches the result for `EDGE_CACHE_MS = 5000`, and returns `{ config: getConfigTree(), applied: [], ignored: [] }` when the variable is unset.

- [ ] **Step 1: Pick the dependency.** Load `agent-skills:working-with-vercel` and confirm the current `@vercel/edge-config` read semantics (`createClient(...).getAll()`) and plan limits, then `pnpm add @vercel/edge-config@<exact version at least two weeks old>`.
- [ ] **Step 2: Write failing tests** (inject `read`): `applies a live key and re-validates` (`AI_REVIEW_REVIEWERS__CLAUDE__ENABLED: false` flips `reviewers.claude.enabled`); `Edge beats env` (base built with env `enabled=true`, Edge says false); `ignores a non-live key and reports it`; `ignores an unknown AI_REVIEW key and reports the closest path`; `ignores a value that fails the schema (concurrency 0) without dropping other keys`; `returns the cold config unchanged and applied empty when EDGE_CONFIG is unset`; `read throwing returns the cold config with error set`; `a non-object payload is treated as empty`; `caches for 5 seconds and refetches after`; `the returned config is frozen and the base config is not mutated`.
- [ ] **Step 3: Run** `pnpm vitest run src/config/edge.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** `applyLiveOverrides`: `structuredClone` the base, apply each accepted key through `setAt`, validate the whole clone with `ConfigSchema.safeParse` per key (a failing key is ignored, others stay), deep-freeze. `getEffectiveConfig` wraps the Edge read in a 2 s timeout and never throws.
- [ ] **Step 5: Run** the file, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(config): Edge Config live overrides`.

### Task 8: Use the effective config on the hosted path

**Files:** Modify `src/reviewers.ts` (+test), `src/webhook-handler.ts`, `api/github/review-run.ts`, `api/debug.ts` (+`api/debug.test.ts`), `.env.example`, `docs/configuration.md`.

**Interfaces:**
- Consumes: `getEffectiveConfig`.
- Produces: `buildAppConfig(id, opts, tree = getConfigTree())` (new optional third parameter) and `getLiveReviewerAppConfig(id: ReviewerId, opts?: GetConfigOptions): Promise<AppConfig>`, which builds from `(await getEffectiveConfig()).config`.

- [ ] **Step 1: Write failing tests.** `reviewers.test.ts`: `getLiveReviewerAppConfig reflects an Edge disable (reviewEnabled false)`; `a reviewer disabled in Edge returns 503 from the handler` (in the webhook handler test file); `debug reports edge status` (`api/debug.test.ts`: authorized response has an `edge` object with `enabled`, `applied`, `ignored`, `error` at the top level, listing an ignored typo key).
- [ ] **Step 2: Run** those files. Expected: FAIL.
- [ ] **Step 3: Implement.** Find the hosted call sites with `rg -n "getReviewerAppConfig\(" src api`; switch the webhook handler and `review-run` to `getLiveReviewerAppConfig`; leave CLI sites (`watch`, `audit`, `review`, `gate`) on the sync form. Make `reviewerReadiness` unchanged. Add the `edge` block to `api/debug.ts`. Add `EDGE_CONFIG` (optional, env-only) with a two-line comment to `.env.example`.
- [ ] **Step 4: Run** `pnpm docs:config && pnpm typecheck && pnpm lint && pnpm test`. Expected: green.
- [ ] **Step 5: Commit** `feat: apply Edge Config overrides on the hosted path`.

---

## Slice 5: per-repo override files

### Task 9: Repo config schema and fetch

**Files:** Create `src/repo-config/schema.ts`, `src/repo-config/fetch.ts` and tests.

**Interfaces:**
- Produces:
  - `RepoConfigSchema` (strict): `{ version: 1; reviewers?: Record<id, { enabled?: false; runOn?: Tier[]; skills?: Record<skillName, { enabled: false }> }>; routing?: { sensitivePathPatterns?: string[] }; review?: { minSeverity?: "P3" | "P2" | "P1"; customPrompt?: string (max 2000 chars); command?: string }; }`
  - `fetchRepoConfig(args: { octokit: RepoConfigOctokit; owner: string; repo: string; kv: Kv | null }): Promise<{ config?: RepoConfig; note?: string }>`. It reads the default branch name and head sha, then `.github/ai-review.yml` at that ref. A 404 returns `{}`. Content over 20,000 bytes, a non-file response, bad YAML or a schema failure returns `{ note }` where the note is one line, at most 200 characters, and never echoes values. Results (including notes) are cached in KV under `repo-config:<owner>/<repo>@<defaultBranchSha>` for 600 s. Any thrown error returns `{ note: "repo config could not be read" }`.

- [ ] **Step 1: Write failing tests.** Schema: `rejects enabled true`; `rejects an unknown key`; `rejects an unknown skill name`; `accepts a minimal file`. Fetch (fake octokit): `reads the default branch ref, not the PR head`; `404 returns empty`; `oversize returns a note`; `directory response returns a note`; `bad yaml returns a note without echoing content`; `cache hit skips getContent`; `octokit throwing returns the generic note`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Skill names are validated against `SKILL_NAMES` from `src/skill-names.ts`. Decode base64 content, parse with `yaml`.
- [ ] **Step 4: Run** `pnpm vitest run src/repo-config && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo-config): schema and default-branch fetch`.

### Task 10: Monotone merge

**Files:** Create `src/repo-config/merge.ts`, `src/repo-config/merge.test.ts`; modify `src/config/schema.ts` (add `review.minSeverity`, default `P3`, allowed `P3|P2|P1`), `src/config/schema.test.ts`.

**Interfaces:**
- Produces:
  - `interface RepoOverrides { reviewerDisabled: boolean; runOn?: Tier[]; disabledSkills: ReadonlySet<string>; extraSensitivePatterns: string[]; minSeverity: "P3" | "P2" | "P1"; customPrompt?: string; command?: string }`
  - `mergeRepoConfig(args: { deployment: Config; sources: Record<string, ValueSource>; reviewerId: string; repo: RepoConfig | undefined }): RepoOverrides`

- [ ] **Step 1: Write failing tests.** `no repo file yields the deployment values (nothing disabled, floor from deployment)`; `repo disable turns the reviewer off even when the deployment enables it`; `repo cannot enable a deployment-disabled reviewer` (deployment `enabled:false` stays disabled); `runOn is the intersection and an empty intersection disables the reviewer`; `minSeverity takes the stricter of deployment and repo`; `sensitive patterns are appended and deduplicated`; `customPrompt from the repo applies only when the deployment value came from yaml or default`; `env-sourced customPrompt wins over the repo`; `command follows the same rule`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `mergeRepoConfig` and the `review.minSeverity` schema key (run `pnpm docs:config`).
- [ ] **Step 4: Run** `pnpm vitest run src/repo-config src/config && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(repo-config): monotone merge and review.minSeverity`.

### Task 11: Apply the overrides in the review path

**Files:** Create `src/severity-floor.ts` (+test); modify `src/router.ts`, `src/review.ts`, `src/github-app.ts`, `src/webhook-handler.ts` and their tests.

**Interfaces:**
- Produces: `applySeverityFloor<T extends { severity: string }>(findings: T[], floor: "P3" | "P2" | "P1"): { kept: T[]; dropped: T[] }` (never drops P0 or P1; floor `P1` drops P2 and P3). `routeReviewerModel(context, reviewerId, routing = getConfigTree().routing)` and `shouldRunOnTier(config, reviewerId, tier, repoRunOn?)` gain optional parameters. `buildReview` args gain `repoOverrides?: RepoOverrides` and `repoNote?: string`.

- [ ] **Step 1: Write failing tests.** `severity-floor.test.ts`: P3 floor keeps everything; P2 floor drops P3; P1 floor drops P2 and P3; P0 and P1 survive any floor. `router.test.ts`: extra sensitive patterns force `complex` for a path the deployment would call `normal`. `github-app.test.ts`: `maybeSubmitReview skips when the repo file disables the reviewer` (status `skipped`, reason names the repo file); `passes the repo overrides and note into buildReview`; `a repo-file fetch failure still posts the review`. `review.test.ts`: `a disabled skill does not run`; `the repo customPrompt reaches the agent prompt`; `floor-dropped findings are recorded as ADAPTIVE_LIMIT discards`; `the review body carries the repo note as one line`; `runOn intersection posts nothing when the tier is excluded`. `webhook-handler` test: `an issue_comment using the repo command triggers a review, and the deployment command does not when the repo sets another`.
- [ ] **Step 2: Run** the affected files. Expected: FAIL.
- [ ] **Step 3: Implement.** In `maybeSubmitReview`, after the draft check, call `fetchRepoConfig` then `mergeRepoConfig`; return `skipped` when `reviewerDisabled`; pass `repoOverrides` and the note to `buildReview`. In `review.ts` use the overrides where the code already reads `getConfigTree().review.customPrompt` (around line 2074), `routeReviewerModel`/`shouldRunOnTier` (around line 2081), the skills list (filter by `disabledSkills`), and the notice-composition spot used by the partial-review and limit notices (append the note). Apply `applySeverityFloor` to each agent's findings before `mergeReviews`, using the effective floor and recording drops through the existing discards collector. In the webhook handler, for an `issue_comment` that fails the deployment command parse and whose body starts with `/`, load the repo config and re-parse with `overrides.command`; if the repo sets a command, only that command applies in that repo.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint && pnpm test`. Expected: green.
- [ ] **Step 5: Commit** `feat(review): apply per-repo override files`.

### Task 12: Docs, spec status and security pass

**Files:** Modify `CLAUDE.md`, `docs/configuration.md`, `docs/adding-a-reviewer.md`, the spec; create `docs/repo-config.md`.

- [ ] **Step 1: Write `docs/repo-config.md`** (what a repo can set, what it cannot, default-branch rule, the note on invalid files, an example file). Update CLAUDE.md: Key files rows for `src/config/live.ts`, `src/config/edge.ts`, `src/repo-config/`, `src/severity-floor.ts`; the Environment variables section gains `EDGE_CONFIG`; refresh the test count.
- [ ] **Step 2: Update the spec**: add the rulings from this plan to section 8, and mark slices 3-5 shipped in the header. Per AGENTS.md, run `no-ai-slop` then `humanizer` on every doc edited in this task before saving.
- [ ] **Step 3: Run** the `security-review` skill and the `typescript-reviewer` and `security-reviewer` agents in parallel on the slice 5 diff (the repo file is attacker-influenced input: prompt injection through `customPrompt`, oversize bodies, KV key construction from `owner/repo`). Fix real findings with a failing test first.
- [ ] **Step 4: Run** `pnpm docs:config && pnpm typecheck && pnpm lint && pnpm test`, then `ai-review review --full` once per AGENTS.md. Fix real findings.
- [ ] **Step 5: Commit** `docs: edge config, repo config, spec status`.
