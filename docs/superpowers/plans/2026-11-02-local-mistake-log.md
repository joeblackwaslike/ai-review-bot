# Local Mistake Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every finding from `ai-review review` and `ai-review gate` to an append-only local JSONL log with reviewer provenance and the implementing session id, then add `ai-review mistakes ingest` to resolve sessions and no-mistakes decisions.

**Architecture:** A CLI-only `src/mistakes/` module owns the record schema and a fail-open sink. `runAuditPass`/`runReviewPasses` expose the per-agent reviews they currently merge away, so findings keep their skill. `runLocalReview` and `runGate` take an injected sink (the CLI builds it), so existing tests never write to the real home directory.

**Tech Stack:** TypeScript ESM, zod, vitest (tests colocated), biome, node:fs.

**Spec:** `docs/superpowers/specs/2026-11-02-local-mistake-log-design.md`

## Global Constraints

- Log root `~/.ai-review/mistakes/<owner>__<repo>/<UTC timestamp>-<runId>.jsonl`, one file per invocation; `AI_REVIEW_MISTAKES_DIR` overrides the root.
- Every line carries `v: 1`, `type`, `ts`, `runId`, `source` (`review` | `gate`), `repo` (`owner/name`), `branch` (string | null).
- Logging is fail-open: any write error is caught, warned once on stderr, and the run continues.
- `src/mistakes/` is CLI-only: never imported from webhook paths (`api/`, `src/github-app.ts`, `src/scheduler.ts`).
- The log stores session ids, never transcript content. Unknown session means `sessionId: null`, `source: null`; never a guess.
- Raw capture files are never modified after the run ends; ingest writes `ingest-<ts>.jsonl` beside them.
- Code style: tabs, `.js` import suffixes, named exports only, no inline comments, no section banners.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass before every commit.

## Spec amendment (applied in Task 1)

Findings are logged per agent, before the merge, so each row keeps its skill, provider and model. The spec's `finding.skills[]` becomes `skill` (string), and a `survived` boolean says whether the finding's `findingKey` is present in the merged review. Gate `event` records carry the ledger `findingId` plus `path`, `title`, `severity` so analysis can join to findings by `findingKey(path, title)`.

## Review Focus

- Unwritable or missing log root: the review or gate still completes and prints exactly one warning.
- Detached HEAD with several or no branches pointing at it, and a repo with no `origin`: `branch` is the first branch from `git for-each-ref --points-at HEAD refs/heads/`, else null; nothing throws.
- A finding body with newlines, quotes, unicode or 100 KB of text stays one valid JSON line.
- Two runs started in the same second write different files and neither loses lines.
- An empty scope (zero agents attempted) writes a `run` record and no `finding` records; a gate round with a failed provider writes `partial: true`.

---

### Task 1: Record schema, log sink, session lookup

**Files:**
- Create: `src/mistakes/types.ts`, `src/mistakes/log.ts`, `src/mistakes/session.ts`
- Test: `src/mistakes/log.test.ts`, `src/mistakes/session.test.ts`
- Modify: `docs/superpowers/specs/2026-11-02-local-mistake-log-design.md` (apply the amendment above to the Records section)

**Interfaces:**
- Produces (`types.ts`): zod schemas and inferred types `Implementer`, `RunRecord`, `FindingRecord`, `EventRecord`, `MistakeRecord` (discriminated union on `type`: `"run" | "finding" | "event"`). Common fields as in Global Constraints. `RunRecord` adds `headSha`, `mergeBase: string | null`, `scope`, `round: number | null`, `costUsd`, `durationSeconds`, `providers: string[]`, `models: string[]`, `agentsAttempted`, `agentsSucceeded`, `partial: boolean`, `reportPath: string | null`, `implementer: Implementer`. `FindingRecord` adds `findingKey`, `skill`, `provider`, `model`, `severity`, `category`, `confidence`, `title`, `body`, `evidence`, `suppressible`, `path: string | null`, `line: number | null`, `startLine: number | null`, `suggestion: string | null`, `survived: boolean`. `EventRecord` adds `findingId`, `status` (`"fixed" | "open" | "reopened" | "approved" | "skipped" | "rejected"`), `by` (`"gate-inferred" | "no-mistakes" | "agent"`), `atHead: string | null`, `fixCommit: string | null`, `path: string | null`, `title`, `severity`, `note: string | null`.
- Produces (`log.ts`): `interface MistakeLog { runId: string; path: string; append(rec: MistakeRecordBody): void }` where `MistakeRecordBody` is a record minus the common fields; `openMistakeLog(opts: { root?: string; owner: string; repo: string; source: "review" | "gate"; branch: string | null; now?: () => Date; runId?: string }): MistakeLog`; `findingKey(f: { path: string | null; title: string }): string` (first 12 hex of sha1 over `path|lowercased trimmed title`, empty string for null path); `findingRecords(opts: { agentReviews: AgentReview[]; merged: ModelReview }): FindingRecordBody[]`.
- Produces (`session.ts`): `implementerFromEnv(env: NodeJS.ProcessEnv): Implementer`; `branchForHead(runGit: GitRunner): string | null` (`GitRunner` from `src/sources.ts`).
- Consumes: `ModelReview` from `src/review.ts`; `AgentReview = { provider: Provider; model: string; skill: string; review: ModelReview }`, defined and exported from `src/mistakes/types.ts` (Provider from `src/models.ts`).

- [ ] **Step 1: Write failing tests.** `log.test.ts`: `findingKey` is stable and case/whitespace-insensitive on title and differs by path; `openMistakeLog` with a temp `root` writes `v:1` lines that parse with `MistakeRecord`; a body with newlines, quotes, unicode and 100 KB stays one line; two logs opened with the same `now` produce different files; with `root` pointing at a file (unwritable) `append` does not throw and `console.error` is called exactly once across three appends; `findingRecords` sets `survived: true` only for agent findings whose key is in `merged` (inline by `commentKey`-equivalent path/title, general by title) and one row per agent finding. `session.test.ts`: `implementerFromEnv({CLAUDE_CODE_SESSION_ID: "abc"})` gives `{agent:"claude-code", sessionId:"abc", source:"env", confidence:"high"}`; empty env gives all-null; `branchForHead` returns the first branch from a stubbed `for-each-ref` output, falls back to `rev-parse --abbrev-ref HEAD` unless it prints `HEAD`, else null, and returns null when the runner throws.
- [ ] **Step 2: Run** `pnpm vitest run src/mistakes` — expect FAIL (modules missing).
- [ ] **Step 3: Implement** the three files to the signatures above. `append` uses `mkdirSync(dirname, {recursive:true})` then `appendFileSync(path, JSON.stringify(rec) + "\n")` in try/catch with a module-level once-flag per log instance. Timestamp in the file name is `now().toISOString().replace(/[:.]/g, "-")`; `runId` defaults to `randomUUID()`.
- [ ] **Step 4: Run** `pnpm vitest run src/mistakes && pnpm typecheck && pnpm lint` — expect PASS.
- [ ] **Step 5: Commit** `feat(mistakes): add record schema, fail-open log sink and session lookup`.

### Task 2: Expose per-agent reviews from the review passes

**Files:**
- Modify: `src/audit.ts` (`runAuditPass` return, `ReviewPassResult`, `runReviewPasses`)
- Test: `src/audit.test.ts`

**Interfaces:**
- Consumes: `AgentReview` (Task 1).
- Produces: `runAuditPass` additionally returns `agentReviews: { skill: string; review: ModelReview }[]` (skill is the same basename used in `toRecord`, e.g. `code-reviewer.md` without extension); `ReviewPassResult.agentReviews?: AgentReview[]` (optional so injected test doubles keep compiling), filled by `runReviewPasses` with the provider and `selection.model` added.

- [ ] **Step 1: Write failing tests** in `src/audit.test.ts`: with the existing mocked agents, `runAuditPass` returns one `agentReviews` entry per successful agent keyed by skill basename, none for failed agents; `runReviewPasses` returns them with `provider` and `model` set across two providers.
- [ ] **Step 2: Run** `pnpm vitest run src/audit.test.ts` — expect FAIL on the new assertions only.
- [ ] **Step 3: Implement** by collecting `{skill, review}` for `o.status === "ok"` inside the existing outcome loop (batches accumulate), and mapping them in `runReviewPasses`. Do not change `mergeReviews` inputs or any existing return field.
- [ ] **Step 4: Run** `pnpm test` — expect all existing tests still PASS.
- [ ] **Step 5: Commit** `feat(audit): expose per-agent reviews from review passes`.

### Task 3: Log findings from `ai-review review`

**Files:**
- Modify: `src/audit.ts` (`runLocalReview`, `runReviewPasses` return of `mergeBase` not needed), `src/cli.ts` (`cmdReview`)
- Test: `src/audit.test.ts`, `src/mistakes/review-log.test.ts`
- Create: `src/mistakes/capture.ts`

**Interfaces:**
- Consumes: `MistakeLog`, `findingRecords`, `implementerFromEnv`, `branchForHead`, `AgentReview`.
- Produces (`capture.ts`): `logReviewRun(opts: { log: MistakeLog; headSha: string; scope: string; costUsd: number; durationSeconds: number; providers: string[]; models: string[]; agentsAttempted: number; agentsSucceeded: number; reportPath: string; agentReviews: AgentReview[]; merged: ModelReview; env: NodeJS.ProcessEnv }): void` writing one `run` (`round: null`, `mergeBase: null`, `partial: agentsSucceeded < agentsAttempted`, `implementer` from env) then one `finding` per agent finding. `runLocalReview` gains optional `mistakes?: MistakeLog`; `ReviewPassResult` is extended with `agentsAttempted/agentsSucceeded` already present.

- [ ] **Step 1: Write failing tests.** `review-log.test.ts`: `logReviewRun` with two agent reviews (one finding each, one surviving the merge) writes 1 run + 2 finding lines with correct `survived`, `partial:false`, session id from env; zero agents attempted writes only the run line. `audit.test.ts`: `runLocalReview` with an injected `mistakes` log and stubbed `resolveAuthFor`/agents calls it once with the report path; without `mistakes` nothing is written and behaviour is unchanged.
- [ ] **Step 2: Run** `pnpm vitest run src/mistakes src/audit.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `capture.ts` and call it in `runLocalReview` after the report is written (wrapped so a throw cannot fail the review). In `cmdReview`, build the log with `openMistakeLog({owner, repo, source:"review", branch: branchForHead(runGit)})` and pass it in; `headSha` comes from `git rev-parse HEAD`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm lint` — expect PASS.
- [ ] **Step 5: Commit** `feat(review): record every finding to the local mistake log`.

### Task 4: Log findings and fix events from `ai-review gate`

**Files:**
- Modify: `src/gate/run.ts` (`GateOptions`, `runGate`), `src/cli.ts` (gate command)
- Create: `src/mistakes/gate-events.ts`
- Test: `src/gate/run.test.ts`, `src/mistakes/gate-events.test.ts`

**Interfaces:**
- Consumes: `LedgerEntry` (`src/ledger/types.ts`), `logReviewRun`-style helpers from Task 3.
- Produces: `diffRoundEvents(before: readonly LedgerEntry[], after: readonly LedgerEntry[], head: string): EventRecordBody[]` emitting `fixed` (before `open` or missing, after `fixed`, `by: "gate-inferred"`, `atHead: head`, `note` from the `inferred:` evidence string) and `reopened` (before `fixed`, after `open`); `GateOptions.mistakes?: MistakeLog`.

- [ ] **Step 1: Write failing tests.** `gate-events.test.ts`: open→fixed yields one `fixed` event with path/title/severity copied from the entry; fixed→open yields `reopened`; unchanged and still-open entries yield nothing. `run.test.ts`: a two-round `runGate` with an injected log and fake `review` returning a finding, then none after a changed diff, writes `run` (with `round`, `mergeBase`, `partial:false`) and `finding` rows in round 1 and a `fixed` event in round 2; a round where one provider fully failed writes `partial: true`; a branch with no code files writes a `run` record only.
- [ ] **Step 2: Run** `pnpm vitest run src/gate src/mistakes` — expect FAIL.
- [ ] **Step 3: Implement** `diffRoundEvents` and hook `runGate` after `applyRound` (before report output): log `run` and per-agent findings from `pass.agentReviews` (skip when `pass === null`), then events from `diffRoundEvents(store.entries, result.store.entries, head)`. `implementer` is all-null for gate. The CLI gate command opens the log with `branch: branchForHead(runGit)`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm lint` — expect PASS.
- [ ] **Step 5: Commit** `feat(gate): record findings and inferred fixes to the local mistake log`.

### Task 5: Inspect the transcript and no-mistakes formats (spike, no product code)

**Files:**
- Modify: `docs/superpowers/specs/2026-11-02-local-mistake-log-design.md` (add an "Observed formats" section)

- [ ] **Step 1:** Read one Claude Code transcript under `~/.claude/projects/-Users-joe-github-joeblackwaslike-ai-review-bot/` with `jq` (keys only, never print message content) and record which of `sessionId`, `cwd`, `gitBranch` exist per line and whether commit shas appear in tool results.
- [ ] **Step 2:** Inspect `~/.no-mistakes/logs/<runId>/`, `~/.no-mistakes/evidence/<id>/` and `~/.no-mistakes/eval/registry.sqlite` (`sqlite3 .schema`, then one row of key names) and `no-mistakes runs` output. Record where approve/skip/fix decisions live, and how a run maps to branch and head sha.
- [ ] **Step 3:** Check what the Codex CLI exposes in its environment for a session id (`env` inside a codex run, `~/.codex/sessions` layout) and record it. If nothing reliable exists, state that `implementer.agent: "codex"` is not captured.
- [ ] **Step 4:** Write the findings into the spec section (formats, field names, what is unverified) and commit `docs(spec): record observed transcript and no-mistakes formats`.

### Task 6: Ingest command

**Files:**
- Create: `src/mistakes/ingest.ts`, `src/mistakes/transcripts.ts`, `src/mistakes/nomistakes.ts`
- Modify: `src/cli.ts` (register `mistakes ingest [--repo <owner/name>] [--root <dir>]`)
- Test: `src/mistakes/ingest.test.ts`, `src/mistakes/transcripts.test.ts`, `src/mistakes/nomistakes.test.ts` (fixtures under `src/mistakes/fixtures/`, synthetic, no real transcript content)

**Interfaces:**
- Consumes: record schemas (Task 1) and the formats recorded in Task 5.
- Produces: `ingest(opts: { root: string; repo?: string; transcriptsDir?: string; noMistakesDir?: string; now?: () => Date }): Promise<{ resolved: { byReviewRow: number; byTranscript: number }; unresolved: number; events: number; file: string | null }>`. Output file `<root>/<owner>__<repo>/ingest-<ts>.jsonl` holds `event` records for no-mistakes decisions and `run`-shaped annotation lines `{type:"annotation", runId, implementer}` for resolved gate runs. Capture files are never opened for writing.

- [ ] **Step 1: Write failing tests** with synthetic fixtures: a gate run on branch `b` with a null implementer and a review run on `b` with session `s1` resolves to `s1` with `source:"resolved"`, `confidence:"high"`; with no review row, a transcript fixture whose lines mention branch `b` resolves to its session with `confidence:"medium"`; no match leaves it unresolved and writes no annotation; a no-mistakes decision fixture for the same branch and head yields one `event` with `by:"no-mistakes"`; capture files are byte-identical after ingest; running ingest twice does not duplicate annotations already present in an earlier `ingest-*.jsonl`.
- [ ] **Step 2: Run** `pnpm vitest run src/mistakes` — expect FAIL.
- [ ] **Step 3: Implement** resolution order: same repo and branch `review` run with a session id (latest before the gate run's `ts` wins), then transcript scan using only fields confirmed in Task 5, then unresolved. Parsers read the no-mistakes format recorded in Task 5 and skip unknown shapes with a counted warning.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm lint` — expect PASS.
- [ ] **Step 5: Commit** `feat(mistakes): add ingest to resolve sessions and no-mistakes decisions`.

### Task 7: Docs and live verification

**Files:**
- Modify: `CLAUDE.md` (Key files table row for `src/mistakes/`; one bullet under "Local audit & review" naming the log, its location, `AI_REVIEW_MISTAKES_DIR`, and `mistakes ingest`)

- [ ] **Step 1:** Add the CLAUDE.md entries; no new prose beyond the table row and one bullet.
- [ ] **Step 2: Live check.** Run `pnpm build` equivalent for the CLI if needed, then in a scratch git repo run `ai-review review` and confirm the JSONL has a `run` line with the session id from `CLAUDE_CODE_SESSION_ID` and `finding` lines with `skill`, `provider`, `model`. Run `ai-review gate` twice around a fix commit and confirm `fixed` event.
- [ ] **Step 3:** Run `ai-review mistakes ingest` against the real `~/.ai-review/mistakes` and `feat/review-precision-phase-b*` branches and report resolved counts by path.
- [ ] **Step 4:** `pnpm typecheck && pnpm lint && pnpm test`, then commit `docs: document the local mistake log`.
