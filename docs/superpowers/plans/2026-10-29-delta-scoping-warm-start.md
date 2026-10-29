# Delta Scoping and Warm Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each re-review round reviews only the delta since the last review the bot posted, with or without KV, and a restarted `ai-review watch` stops forcing a cold full review.

**Architecture:** `buildReview` resolves one baseline per run (KV state, else one derived from the latest own review and the Sprint 2 ledger, else none) and the triage gate runs on it. Any run that cannot use a delta runs FULL, carries the baseline's open findings, and revalidates them against current file patches. `watch.ts` drops its cycle-1 force and KV seeding.

**Tech Stack:** TypeScript ESM, vitest, Octokit, AI SDK `generateObject`. Run from the repo root with `npm run typecheck`, `npm run lint`, `npm run test`.

**Spec:** [docs/superpowers/specs/2026-10-29-delta-scoping-warm-start-design.md](../specs/2026-10-29-delta-scoping-warm-start-design.md)

## Global Constraints

- Named exports only, `.js` import specifiers, Biome formatting (`npm run lint -- --write`).
- Every GitHub-facing test fake must reject unknown routes and assert request params. Sprint 2 shipped a GraphQL call with no `variables` because the fake ignored them. The existing `buildOctokit` in `src/review.test.ts` returns a reviews response for any unknown route, so new `buildReview` tests use the strict fake from Task 1.
- Failing-first: for every test step, run it before the implementation and keep the red output for the PR description.
- A forced run (`--force`) still skips the idempotency check, the delta gate and the silence rule, and always posts.
- A baseline from KV wins over a derived one. Removing KV is Sprint 5.
- Partial-review notices do not invalidate a baseline.
- `REVIEW_CLAIM_TTL_SECONDS` is 1200 and unchanged.

## Review Focus

- A forced round between ordinary rounds (A raised, forced round raises B, next round still holds A): Task 4.
- A cold ledger with inline comments in the source review: Task 3 and Task 4 (`full (baseline incomplete)`).
- A fix that lands in a fallback round, followed by an unrelated push: Task 2 revalidation and Task 4.
- A review landing between the reviews fetch and the ledger fetch: Task 3 and Task 4.
- Compare returns `diverged` or throws, and the only prior blocker must survive a clean agent result: Task 4.

---

### Task 1: Ledger exposes `reviewIds`, and a strict Octokit fake

**Files:**
- Modify: `src/ledger/github.ts` (`LedgerEvidence`, `fetchLedgerEvidence`), `src/ledger/live.ts` (`LoadedLedger`, `loadLedger`)
- Modify: `src/testing.ts` (add `buildStrictOctokit`)
- Test: `src/ledger/github.test.ts`, `src/ledger/live.test.ts`

**Interfaces:**
- Produces: `LedgerEvidence.reviewIds: number[]` (ids of own reviews with `submitted_at` set, in the same sort order that assigns `roundIndex`); `LoadedLedger.reviewIds: number[]` (empty when `warm: false`).
- Produces: `buildStrictOctokit(routes: Record<string, (params: Record<string, unknown>) => unknown>): { request, paginate, graphql }` in `src/testing.ts`. A call whose route is not a key of `routes` throws `Error("unexpected route: <route>")`. `paginate(route, params)` calls the same handler and returns its array.

- [ ] **Step 1: Write failing tests.** In `github.test.ts`, `fetchLedgerEvidence returns own review ids in round order` (reviews fetched out of order by `submitted_at`, one non-own review, one unsubmitted; expect `[idOfEarliest, idOfLatest]`). In `live.test.ts`, `loadLedger returns reviewIds and an empty list when cold`. Both use `buildStrictOctokit` and assert the GraphQL request carries `variables: { owner, repo, pr }`.
- [ ] **Step 2: Run** `npm run test -- src/ledger` — expect FAIL (`reviewIds` undefined, `buildStrictOctokit` not exported).
- [ ] **Step 3: Implement** the interface changes above. `loadLedger` returns `reviewIds: []` in its catch branch.
- [ ] **Step 4: Run** `npm run test -- src/ledger` — expect PASS.
- [ ] **Step 5: Commit** `feat(ledger): expose own review ids in round order`.

### Task 2: Compare outcome and revalidation in `triage.ts`

**Files:**
- Modify: `src/triage.ts`
- Test: `src/triage.test.ts`

**Interfaces:**
- Consumes: `PersistedFinding` from `src/review-state.ts`.
- Produces: `DeltaMeta.status: string`; `fetchDeltaMeta(...)` now returns `Promise<DeltaMeta | null>`, `null` when the request throws (logged with `console.warn`, reason included) or `data.status !== "ahead"`.
- Produces: `triageReReview(selection, deltaDiff, openFindings, auth?, mode: "delta" | "current" = "delta")`. `mode: "current"` changes only the prompt header line to "The current patches of the files your open findings name:".
- Produces: `revalidateFindings(selection: ModelSelection, carried: PersistedFinding[], files: DeltaFile[], auth?: ResolvedAuth): Promise<string[]>` returning resolved ids. Sends only carried findings whose `path` is set and whose file is in `files`, with those files' patches (each through the existing `trimPatch`-style cap, total 60,000 characters; findings whose file does not fit stay unsent). Returns `[]` with no model call when nothing is sendable, and `[]` on model error.

- [ ] **Step 1: Write failing tests.** `fetchDeltaMeta returns null when the compare request throws`; `fetchDeltaMeta returns null when status is diverged`; `fetchDeltaMeta passes basehead old...new` (strict fake asserts the param string); `revalidateFindings sends only path-bearing findings and their file patches`; `revalidateFindings stays under the character cap`; `revalidateFindings returns [] on model error`; `triageReReview mode current uses the current-patches header`.
- [ ] **Step 2: Run** `npm run test -- src/triage.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** per the interfaces. Update the one existing caller type in `src/review.ts` only as far as typecheck requires; behavior changes land in Task 4.
- [ ] **Step 4: Run** `npm run test -- src/triage.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(triage): treat unusable compares as null and add current-patch revalidation`.

### Task 3: `deriveBaseline`

**Files:**
- Create: `src/baseline.ts`
- Modify: `src/review-state.ts` (export `parseBodyFindings` already exists; export `parsePriorReview`; drop the body fallback and the `priorOwnReview` parameter from `loadReviewState`)
- Test: `src/baseline.test.ts`, `src/review-state.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `LedgerEntry` from `src/ledger/types.ts`; `PersistedFinding`, `ReviewState`, `findingId` from `src/review-state.ts`.
- Produces: `type DerivedBaseline = { state: ReviewState; complete: boolean }`.
- Produces: `deriveBaseline(source: { id: number; body: string } | null, ledger: { entries: Ledger; reviewIds: number[]; warm: boolean }): DerivedBaseline | null`. `null` when `source` is null or the body has no `ai-review:sha` marker (legacy `Reviewed commit:` bodies parse as today).
- Rules (spec "Where the baseline comes from"): findings = open entries of the ledger round at `reviewIds.indexOf(source.id)`, plus body table rows, plus unanchored-bullet rows (`> - <emoji> **title** (\`path:line\`)`), deduplicated by id; entries with no path and a trailing `(\`path:line\`)` get that path, line and a clean title. `complete` is false when the ledger is cold and the body does not say `Inline comments: none`, or when `reviewIds` lacks `source.id`. `state.event` is `REQUEST_CHANGES` when any finding is open, else `COMMENT`; `reviewCount` is the `ai-review:review` marker.

- [ ] **Step 1: Write failing tests.** `carried row with a path suffix gets path, line and a clean title`; `only the source review's round is read`; `a source with no findings gives an empty list`; `unanchored bullets are recovered`; `cold ledger with inline comments is incomplete`; `cold ledger with Inline comments: none is complete`; `source id missing from reviewIds is incomplete`; `a title ending in parentheses without a path:line pair is untouched`; and in `review-state.test.ts`, `loadReviewState reads KV only` (a KV miss returns null even when given a body). Update existing `review-state.test.ts` cases that relied on the body fallback.
- [ ] **Step 2: Run** `npm run test -- src/baseline.test.ts src/review-state.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `src/baseline.ts` and the `review-state.ts` changes.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(review): derive a review baseline from GitHub`.

### Task 4: `buildReview` uses the baseline

**Files:**
- Modify: `src/review.ts` (`buildReview` ~1268-1600, 1980-2180; `formatReviewBody` footer at ~946 gets `scopeNote`)
- Test: `src/review.test.ts` (new `describe("delta scoping without KV")`)

**Interfaces:**
- Consumes: `deriveBaseline`, `fetchDeltaMeta` (nullable), `revalidateFindings`, `LoadedLedger.reviewIds`, `buildStrictOctokit`.
- Produces: `type ScopeNote` rendered as the footer strings in the spec's table (`scope: delta from <sha7> (kv|github)`, `scope: full (first review|forced|triage|compare failed|compare truncated|baseline incomplete)`), appended after `ledgerNote` and logged once per run with `console.log("review scope", { scope })`.

- [ ] **Step 1: Write failing tests** with `buildStrictOctokit` serving reviews, files, compare, comments and GraphQL routes, and the model and triage mocks already in the file:
  - `cold run scopes to the delta`: no KV, one older own review; compare called once with `basehead` `old...head`; the agents' user message receives only the compare files; footer says `scope: delta from <sha7> (github)`.
  - `KV state still wins`: KV holds a state with a different sha; compare uses the KV sha; footer says `(kv)`.
  - `compare throws`: FULL, footer `full (compare failed)`, delta triage not called, a baseline blocker still gives REQUEST_CHANGES on a clean agent result.
  - `compare diverged`: same.
  - `compare truncated`: delta triage not called and a stubbed resolution is never requested.
  - `fallback revalidation resolves a fixed finding`; `title-only finding is not revalidated`.
  - `forced run carries`: round 1 raises A, forced round 2 raises only B, round 3's derived baseline holds A and B.
  - `same-head forced run with no KV carries the same-head review's findings and continues the count`.
  - `incomplete baseline runs full, carries what was recovered, footer says baseline incomplete`.
  - `source review missing from the ledger's reviewIds is incomplete`.
  - `footer scope note` for each reason not covered above (`first review`, `forced`, `triage`).
- [ ] **Step 2: Run** `npm run test -- src/review.test.ts -t "delta scoping without KV"` — expect FAIL; save the output.
- [ ] **Step 3: Implement.** (a) Keep `priorOwnReview` as is; add a source review selection (latest own review, any head) that keeps its id. (b) Resolve the baseline: KV state (`loadReviewState`, skipped for forced runs only for scoping), else `deriveBaseline` using `fetchLedger()` when `hasOwnReview`. (c) Gate condition becomes `baseline && !force && baseline.lastReviewedSha !== headSha && baseline is complete`. (d) Call `fetchDeltaMeta`; on `null` or truncation skip delta triage and apply no resolutions. (e) On any FULL path with a baseline, set `survivingPrior` from the baseline's open findings, reconcile with the ledger, run `revalidateFindings` for fallback paths and drop the resolved ids. (f) Forced runs: skip the gate but still set `survivingPrior` and the count. (g) `reviewCount` base is the baseline's count, else the highest `ai-review:review` marker among own reviews, else 0; use it in both the footer and `newState`. (h) Compute and render `scopeNote`.
- [ ] **Step 4: Run** `npm run test -- src/review.test.ts` — expect PASS, including all pre-existing tests.
- [ ] **Step 5: Commit** `feat(review): scope re-reviews to the delta without KV`.

### Task 5: Watcher stops forcing cycle 1

**Files:**
- Modify: `src/watch.ts` (remove `hasPostedEver`, the cycle-1 seeding block, the `loadPersistedState` option and its `createUpstashKv`/`loadReviewState` imports, and the stale comments around them), `CLAUDE.md` (watch paragraph)
- Test: `src/watch.test.ts`

**Interfaces:**
- Consumes: `maybeSubmitReview` outcomes (`posted`, `skipped` with `NO_NEW_REVIEW_REASON`).
- Produces: `WatchPrOptions` without `loadPersistedState`; every `submitReview` call passes `force: false`.

- [ ] **Step 1: Write failing tests.** `first cycle sends force false`; `restart on an already-reviewed head ends as no new review and does not post` (stub returns the no-new-review skip). Delete the `ai-review-bot-aou` seeding tests and the `loadPersistedState` option from every remaining test.
- [ ] **Step 2: Run** `npm run test -- src/watch.test.ts` — expect FAIL on the two new tests.
- [ ] **Step 3: Implement** the removals.
- [ ] **Step 4: Run** `npm run test -- src/watch.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `fix(watch): stop forcing a cold review on every restart`.

### Task 6: Real-GitHub check, docs, whole-branch gates

**Files:**
- Modify: `docs/post-mortem-re-review-memory.md` (Prevention bullets for the watch force and KV-free memory point to this spec), `CLAUDE.md` (Key files row for `src/baseline.ts`)
- Create: none committed. The check script lives in the session scratchpad.

- [ ] **Step 1: Run the real-PR check.** A script in the scratchpad lists own reviews for joeblackwaslike/stealth-browser#1, joeblackwaslike/ai-listings#74 and joeblackwaslike/agent-skills#10 with `gh`, runs `fetchLedgerEvidence` + `buildLedger` + `deriveBaseline` for every own review as source, and prints sha, count, finding count and `complete`. Pass criteria: each derived sha equals the marker in its source review, `compare` of that sha to the next review's sha returns `ahead`, and no source review reports `complete: false` with a warm ledger. Paste the table into the PR body and note which rounds were hand-checked against the review body.
- [ ] **Step 2: Update docs** (post-mortem bullets, CLAUDE.md row). Run `no-ai-slop` then `humanizer` over every prose edit before saving.
- [ ] **Step 3: Run the gates:** `npm run typecheck && npm run lint && npm run test`, then `npm run build && node dist/cli.js replay`; expect green and the pinned recycled counts unchanged (Sprint 2: 1, 0, 0, 0, 2, 4).
- [ ] **Step 4: File the follow-up bead** for "advance `lastReviewedSha` only past agents that completed" with the 6-of-14 measurement.
- [ ] **Step 5: Commit** `docs: point post-mortem prevention items at the sprint 3 design`.
