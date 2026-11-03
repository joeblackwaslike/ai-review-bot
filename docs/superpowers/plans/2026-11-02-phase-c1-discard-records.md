# Phase C1 discard records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every finding the review pipeline drops leaves one record with a reason: a log line on every path and a `finding_discards` row when the corpus is enabled.

**Architecture:** Drop sites inside `buildReview` push `Discard` values into one list. `buildReview` becomes a thin wrapper around its current body (`buildReviewInner`) and flushes the list in a `finally`, so every exit (including the "nothing new" `null` return and a throw) records. The flush logs each record and calls an optional `recordDiscards` callback, which `github-app.ts` supplies when `IMPROVE_ENABLED`. The callback inserts into a new table through `insertDiscards`.

**Tech Stack:** TypeScript ESM, Vitest, drizzle-orm + pg-mem test harness (`createTestDb`), `drizzle-kit generate` for the migration.

**Spec:** [docs/superpowers/specs/2026-11-02-phase-c-measurement-design.md](../specs/2026-11-02-phase-c-measurement-design.md) (C1 section). Beads `ai-review-bot-t0c.12`.

## Global Constraints

- Reasons: `SUPPRESSED_SETTLED`, `SUPPRESSED_OPEN`, `RETRACTION`, `OFF_DIFF`, `CAP`, `DISCARDED_BY_VERIFY` (reserved, no source), `RESOLVED_LOCATION`. `OFF_DIFF` carries a sub-code: `OFF_DIFF_PATH`, `OFF_DIFF_LINE`, `BAD_RANGE`.
- `disposition` is `"held"` for `SUPPRESSED_OPEN` and `"dropped"` for every other reason.
- Not recorded: dedupe/merge collapses, the advisory cap, suggestion-block drops.
- A recording error never fails, slows past a catch, or changes a review.
- `src/mistakes/` and `src/auth.ts` are never imported (webhook-path code).
- TypeScript ESM with `.js` import extensions, named exports only, tests colocated, Biome. `pnpm typecheck && pnpm lint && pnpm test` pass before every commit.
- Every new test is shown failing first; quote the failing assertion in the commit body.
- No banner comments, no inline comments unless unavoidable, docstrings on exports.

## Review Focus

- A `recordDiscards` that throws or rejects leaves the posted review, its event and its body unchanged (test in Task 3).
- A round that posts nothing (`buildReview` returns `null`) still records its settled suppressions (Task 2).
- A restatement collapsed by `dedupeClaims` or the exact-key merge produces no record (Task 2).
- A QStash redelivery of the same sha inserts no duplicate rows (Task 1 unique index).
- A discard with no known skill or a path-less general finding stores null, not an empty string (Tasks 1 and 3).

## File Structure

| File | Change |
| --- | --- |
| `src/discards.ts` (+test) | New. `Discard` type, reason constants, `discardKey`, `logDiscards` |
| `src/improve/db/schema.ts` | `finding_discards` table and two enums |
| `src/improve/db/migrations/` | Generated migration |
| `src/improve/db/repo.ts` (+test) | `insertDiscards` |
| `src/review.ts` | Wrapper, collection at each drop site, `recordDiscards` on the context, `buildReviewComments` drop callback |
| `src/github-app.ts` | Pass `recordDiscards` when `improveEnabled` |
| `CLAUDE.md` | Describe the recorder, update test count |

---

### Task 1: Discard type and corpus table

**Files:**
- Create: `src/discards.ts`, `src/discards.test.ts`
- Modify: `src/improve/db/schema.ts`, `src/improve/db/repo.ts`, `src/improve/db/repo.test.ts`, `src/improve/db/schema.test.ts`
- Generate: `src/improve/db/migrations/0003_*.sql` plus `meta/` via `pnpm db:generate`

**Interfaces:**
- Produces in `src/discards.ts`:
  - `DISCARD_REASONS = ["SUPPRESSED_SETTLED","SUPPRESSED_OPEN","RETRACTION","OFF_DIFF","CAP","DISCARDED_BY_VERIFY","RESOLVED_LOCATION"] as const`
  - `OFF_DIFF_CODES = ["OFF_DIFF_PATH","OFF_DIFF_LINE","BAD_RANGE"] as const`
  - `interface Discard { reason: DiscardReason; code: OffDiffCode | null; disposition: "dropped" | "held"; title: string; path: string | null; line: number | null; severity: string | null; skill: string | null; provider: "anthropic" | "openai" }`
  - `discardKey(f: { path: string | null; title: string }): string` — sha1 of `${path ?? ""}|${title.toLowerCase().trim()}`, first 12 hex (the mistake log's `findingKey` formula, copied because `src/mistakes/` is CLI-only).
  - `logDiscards(discards: readonly Discard[], ctx: { owner: string; repo: string; pullNumber: number }): void` — one `console.log("finding discarded", {...})` per record.
- Produces in `src/improve/db/repo.ts`: `insertDiscards(db: Db, rows: DiscardInsert[]): Promise<number>` returning rows inserted; `type DiscardInsert = typeof findingDiscards.$inferInsert`.
- Produces in `schema.ts`: `findingDiscards` with columns `id, provider, owner, repo, pr, reviewSha, reason, code (nullable), disposition, naturalKey, path (nullable), line (nullable), severity (nullable), title, skill (nullable), createdAt`, and a unique index on `(provider, owner, repo, pr, reviewSha, reason, naturalKey)`.

- [ ] **Step 1: Write failing tests.** `discards.test.ts`: `discardKey` is stable across case and surrounding whitespace in the title and differs by path; `discardKey` equals a hard-coded 12-hex value for `{path: "src/a.ts", title: "Off-by-one"}` computed with `createHash("sha1").update("src/a.ts|off-by-one")`; `logDiscards` logs one line per record with the reason. `schema.test.ts`: `findingDiscards` is defined and its reason enum values equal `DISCARD_REASONS`. `repo.test.ts`: `insertDiscards` inserts two rows and reads them back through `db.execute(sql\`select reason, disposition, skill from finding_discards\`)`; a second call with the same unique key inserts 0 rows; a row with `skill: null, path: null, line: null` round-trips as nulls.
- [ ] **Step 2: Run them and confirm they fail** (`pnpm vitest run --pool=forks src/discards.test.ts src/improve/db`). Expected: module/table not found.
- [ ] **Step 3: Implement** `src/discards.ts`, the table in `schema.ts` (pgEnum from the constants), and `insertDiscards` using `.onConflictDoNothing()` on the unique index and `.returning({ id })`. Run `pnpm db:generate` and commit the generated SQL and `meta/` files unedited.
- [ ] **Step 4: Run the tests; they pass.** If pg-mem cannot execute the `ON CONFLICT` form, assert the duplicate case in `repo.integration.test.ts` instead (follow the note at the top of `repo.test.ts`) and keep the other assertions in `repo.test.ts`.
- [ ] **Step 5: Commit** `feat(improve): add finding_discards table and insertDiscards`.

### Task 2: Collect per-agent discards and flush from a wrapper

**Files:**
- Modify: `src/review.ts` (context type near line 122; `buildReview` at ~1768; per-agent loop ~2672-2727; `mergeReviewsDetailed` resolved-key skips ~679-707; return type of the merge helper)
- Test: `src/review.test.ts`

**Interfaces:**
- Consumes: Task 1's `Discard`, `logDiscards`.
- Produces: `ReviewContext.recordDiscards?: (discards: Discard[]) => Promise<void>`; `export async function buildReview(context)` keeps its signature and becomes `try { return await buildReviewInner(context, discards) } finally { await flushDiscards(...) }`; `mergeReviewsDetailed` result gains `resolvedSkipped: Array<ModelInlineComment | ModelGeneralFinding>` (findings removed by `resolvedKeys`).

- [ ] **Step 1: Write failing tests** in a new `describe("discard records")` in `review.test.ts`, using the existing ledger-suppression fixtures in that file:
  - settled repeat: one `SUPPRESSED_SETTLED` record, `disposition: "dropped"`, `skill` equal to the agent's skill path, `provider` set; assert through a `recordDiscards` spy.
  - open restatement: one `SUPPRESSED_OPEN` record with `disposition: "held"`.
  - retraction (with `REVIEWER_TUNING.dropRetractions` forced on for the test): one `RETRACTION` record.
  - resolved location: a new finding at a `resolvedKeys` location produces one `RESOLVED_LOCATION` record.
  - collapsed restatement: two agents report the same claim on one line; the spy sees no record for the loser.
  - nothing-new round: a settled repeat in a round where `buildReview` returns `null` still reaches the spy.
  - every record is also logged: `console.log` called with `"finding discarded"`.
- [ ] **Step 2: Run them; confirm they fail** (spy never called).
- [ ] **Step 3: Implement.** Rename the current `buildReview` body to `buildReviewInner(context, discards: Discard[])` (unexported). Push a `Discard` at the three loop sites in the per-agent `map` (the skill is `allSkills[index].skillPath` for that agent) and for `resolvedSkipped` after the merge. The flush logs with `logDiscards`, then awaits `context.recordDiscards` inside try/catch, logging one `console.warn("discard recording failed", {error})` on failure.
- [ ] **Step 4: Run the new tests and the full `review.test.ts`; all pass.**
- [ ] **Step 5: Commit** `feat(review): record settled, open, retraction and resolved-location discards`.

### Task 3: Late drops, skill attribution and a recording that cannot fail a review

**Files:**
- Modify: `src/review.ts` (`buildReviewComments` ~1518, cap block ~2790-2815, the `skillsByKey` block ~2848-2889)
- Test: `src/review.test.ts`

**Interfaces:**
- Consumes: Task 2's `discards` list and wrapper.
- Produces: `buildReviewComments(files, comments, onDrop?: (comment: ModelInlineComment, code: OffDiffCode) => void)`; the `skillsByKey` map is built whether or not `feedbackEnabled`.

- [ ] **Step 1: Write failing tests.**
  - an off-diff P2 comment: one `OFF_DIFF` record with `code: "OFF_DIFF_LINE"`; an off-diff path gives `OFF_DIFF_PATH`; an inverted range gives `BAD_RANGE`. A dropped P0/P1 is routed into a general finding and produces no record.
  - 52 inline comments: the two overflow comments produce `CAP` records (assert they are the lowest-severity ones).
  - skill attribution: with `feedbackEnabled: false`, an off-diff discard still carries the skill that reported it; a discard whose key has no skill entry has `skill: null`.
  - a general finding with no path records `path: null, line: null`.
  - `recordDiscards` that rejects: the returned review is deep-equal to the one returned with no callback, and `console.warn` got `"discard recording failed"`. Same for a recorder that throws synchronously.
  - a recorder that never resolves: with fake timers, `buildReview` still returns after the 5-second bound and `console.warn` got `"discard recording timed out"`.
  - carried from the Task 2 review: two agents reporting one claim on adjacent lines that `dedupeClaims` collapses produce no record for the loser; with `dropRetractions` off, retraction filler produces no `RETRACTION` record.
- [ ] **Step 2: Run them; confirm they fail.**
- [ ] **Step 3: Implement.** Pass an `onDrop` that pushes `OFF_DIFF` discards; push `CAP` discards from `overflowComments`; hoist the `skillsByKey` construction out of the `feedbackEnabled` branch and look skills up by `commentKey` for late drops. Bound the `recordDiscards` await in `flushDiscards` with a 5-second `Promise.race` timeout (named constant `DISCARD_RECORD_TIMEOUT_MS`); on timeout log one `console.warn("discard recording timed out")` and carry on.
- [ ] **Step 4: Run `pnpm vitest run --pool=forks src/review.test.ts`; all pass.**
- [ ] **Step 5: Commit** `feat(review): record off-diff and cap discards with skill attribution`.

### Task 4: Persist discards on the hosted path

**Files:**
- Modify: `src/github-app.ts` (the `buildReview` call near line 552), `src/improve/capture.ts` or a new helper beside it
- Test: `src/github-app.test.ts` (or the nearest existing test that drives `maybeSubmitReview` with `improveEnabled`)

**Interfaces:**
- Consumes: `insertDiscards`, `Discard`, `discardKey`.
- Produces: `persistDiscards(deps: { db: Db; owner: string; repo: string; pr: number; headSha: string }): (discards: Discard[]) => Promise<void>` in `src/improve/capture.ts`, mapping each `Discard` to a `DiscardInsert` with `naturalKey: discardKey(d)`.

- [ ] **Step 1: Write failing tests.** `persistDiscards` maps fields correctly (including `reviewSha`, `naturalKey`, null passthrough) and calls `insertDiscards` once with all rows; with `improveEnabled: false`, `maybeSubmitReview` passes no `recordDiscards`; with it on, a settled-repeat round inserts a row (use the test DB).
- [ ] **Step 2: Run them; confirm they fail.**
- [ ] **Step 3: Implement** `persistDiscards`; in `github-app.ts` add `recordDiscards: config.improveEnabled ? persistDiscards({ db: getDb(), owner, repo, pr: pullNumber, headSha }) : undefined` to the `buildReview` context. A `getDb()` failure must degrade to no recording, not a thrown review.
- [ ] **Step 4: Include the skill in the unique key.** Five agents restating one settled finding must stay five rows (C3 counts per skill), so change the `finding_discards` unique index to `(provider, owner, repo, pr, reviewSha, reason, naturalKey, coalesce(skill, ''))`. Because this branch is unmerged, regenerate migration `0003` instead of adding `0004`: delete the generated `0003_*.sql`, `meta/0003_snapshot.json` and the `0003` entry in `meta/_journal.json`, then run `pnpm db:generate` and format the snapshot with `pnpm exec biome check --write`. If pg-mem cannot execute the expression index (every `createTestDb()` test then fails at migration load), fall back to a `skill` column that is `NOT NULL DEFAULT ''` with `''` meaning unknown, map `null` to `''` inside `persistDiscards`, and report the fallback as a ruling. Tests: five records differing only in skill insert 5 rows; the same record twice inserts 0 the second time (including with `skill: null`); the duplicate cases run in `repo.integration.test.ts` against real Postgres (`docker run -d --rm --name c1-pg -e POSTGRES_PASSWORD=x -p 54329:5432 postgres:16-alpine`, then `DATABASE_URL_TEST=postgres://postgres:x@localhost:54329/postgres pnpm vitest run --pool=forks src/improve/db/repo.integration.test.ts`; stop the container afterwards).
- [ ] **Step 5: Run the tests; all pass.**
- [ ] **Step 6: Commit** `feat(improve): persist discard records when the corpus is enabled`.

### Task 5: Docs and verification

**Files:** Modify `CLAUDE.md`.

- [ ] **Step 1:** In the merge-layer and anchor-validation sections of `CLAUDE.md`, add one short paragraph: the reasons, that `buildReview` flushes them in a `finally`, the log line, the `finding_discards` table, and that dedupe collapses are not recorded. Add `src/discards.ts` to the Key files table. Update the test count line to the real count.
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm test` all pass; quote the counts.
- [ ] **Step 3: Commit** `docs: describe discard records`.

## Self-Review

- **Spec coverage:** reasons and dispositions (Task 1, 2); not-recorded list (Task 2 test, Global Constraints); collection and skill rule (Tasks 2 and 3); sinks (Tasks 2 and 4); table, migration and repo test (Task 1); recording failure isolation (Task 3). C2, C3 and local-run capture are out of scope by the spec.
- **Types:** `Discard`, `DiscardReason`, `OffDiffCode`, `discardKey`, `insertDiscards` and `recordDiscards` are named identically wherever they appear.
- **Proportion:** the plan states interfaces and test assertions, not bodies.
