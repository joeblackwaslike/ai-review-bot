# Agent Outcome Logs, Failure Classes and Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent outcome leaves a durable structured record, failed agents are classified and the retryable ones retried once, and an agent that did not complete is re-pointed at the whole PR on the next round.

**Architecture:** A pure classifier turns thrown SDK errors into a failure class. Records go to the console, to a hidden `agents` marker in the review body, and to a local JSONL file when the CLI enables it. `buildReview` runs a retry pass after the first agent pass and keeps a pending-coverage set (in the marker and in KV state) that schedules incomplete skills over the whole PR.

**Tech Stack:** TypeScript ESM, vitest, Vercel AI SDK (`ai` 6.x, `@ai-sdk/*`), Octokit. Toolchain is pnpm and Bun now: use `pnpm test -- <path>`, `pnpm typecheck`, `pnpm lint`. Never npm or npx, never `pnpm install` beyond the frozen lockfile.

**Spec:** [docs/superpowers/specs/2026-10-29-agent-failure-logs-and-retry-design.md](../specs/2026-10-29-agent-failure-logs-and-retry-design.md)

## Global Constraints

- Named exports only, `.js` import specifiers, Biome formatting (`pnpm lint -- --write`, scoped to files you changed).
- A record or marker never holds model output, `text`, `response`, `cause` or a free-text error message. Only the local JSONL file adds `message`, cut to 300 characters.
- Failure classes and retryability are exactly the spec's table, in the spec's precedence order.
- Retry: at most one per agent; eligibility needs `max(30 s, first attempt duration)` left before the absolute agent deadline, checked at collection and again right before dispatch.
- Test fakes for GitHub assert request shape; classifier tests use the real SDK error classes.
- Failing-first: run every new test before its implementation and keep the red output for the report.
- Reviews posted before this change have no `agents` marker and must read as "no incomplete skills".

## Review Focus

- A pending skill that completes on a trimmed or incomplete whole-PR input stays pending (Task 7).
- A recovery round that clears a skill posts even when nothing else is new, with and without KV (Task 7).
- Oversized markers never lose the pending list or a non-ok record (Task 3).
- Quoted or duplicated markers cannot feed any consumer, including the sha and count in `deriveBaseline` (Task 2).
- A retry whose pacing delay eats the remaining time is cancelled (Task 5).

---

### Task 1: Failure classifier

**Files:**
- Create: `src/agent-failure.ts`
- Test: `src/agent-failure.test.ts`

**Interfaces:**
- Produces: `type FailureClass = "content_refused" | "output_truncated" | "no_output" | "schema_mismatch" | "auth" | "transient_http" | "invalid_request" | "network" | "unknown"`; `type ErrorName = "AI_NoObjectGeneratedError" | "AI_APICallError" | "AI_RetryError" | "Error" | "other"`; `interface AgentFailure { class: FailureClass; retryable: boolean; httpStatus?: number; finishReason?: string; errorName: ErrorName }`; `classifyAgentError(err: unknown): AgentFailure`.

- [ ] **Step 1: Confirm the SDK facts.** Read the installed type declarations for `NoObjectGeneratedError` (`finishReason`, `usage`, `text`), `APICallError` (`statusCode`, `isRetryable`), `RetryError` (`lastError`, `errors`) and their `.name` values and `isInstance` helpers in `node_modules/ai` and `node_modules/@ai-sdk/provider`. Write the confirmed field names into a short comment block at the top of `agent-failure.ts`. If a spec table rule cannot be implemented from existing fields, stop and report.
- [ ] **Step 2: Write failing tests** with real constructed errors: one case per class; precedence overlaps (`content-filter` finish reason on a `NoObjectGeneratedError` gives `content_refused`; `length` gives `output_truncated`; empty text gives `no_output`; other gives `schema_mismatch`); statuses 401, 403, 408, 409, 429-adjacent 4xx (400, 404, 422), 500, 529; a `RetryError` wrapping each recognized error; `TypeError("fetch failed")` with a `cause` carrying `ECONNRESET` gives `network` and without it gives `unknown`; plain `TypeError` gives `unknown`; a thrown string gives `unknown`. Assert `errorName` for each.
- [ ] **Step 3: Run** `pnpm test -- src/agent-failure.test.ts` — expect FAIL (module missing).
- [ ] **Step 4: Implement** `classifyAgentError` per the spec: unwrap `RetryError.lastError`, then follow `cause` up to three levels, classify the innermost recognized error, then apply the precedence table.
- [ ] **Step 5: Run** the same command — expect PASS. **Commit** `feat(review): classify agent failures`.

### Task 2: One metadata block reader for every consumer

**Files:**
- Create: `src/review-metadata.ts`
- Modify: `src/review.ts` (`parseReviewMetadata`, the `alreadyReviewed` check, own-review selection), `src/baseline.ts` (sha and count reads)
- Test: `src/review-metadata.test.ts`, extend `src/baseline.test.ts`, `src/review.test.ts`

**Interfaces:**
- Produces: `readMetadataBlock(body: string): Map<string, string> | null`. Returns the `key=value` pairs from the `<!-- ai-review:key=value -->` lines that start at column 0 in the block just above the blank line and `---` footer. Returns `null` for a body with no such block (legacy body). A duplicated key makes the whole result `null` for that key being read, never a thrown error.
- Consumes: the body layout written by `formatReviewBody` (markers, blank line, `---`, model and cost line).

- [ ] **Step 1: Write failing tests.** Block above the footer is read; a marker quoted with `> ` is ignored; a marker in the middle of summary text is ignored; a duplicated key is rejected; a legacy body with no block returns `null` and `parseReviewMetadata` still parses it by whole-body search as before; `deriveBaseline` and `alreadyReviewed` ignore a quoted earlier sha while reading the real one.
- [ ] **Step 2: Run** `pnpm test -- src/review-metadata.test.ts src/baseline.test.ts src/review.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `readMetadataBlock`, and route `parseReviewMetadata`, the sha and count in `deriveBaseline`, and the `alreadyReviewed` check through it with the legacy fallback.
- [ ] **Step 4: Run** the same command — expect PASS including all existing tests. **Commit** `fix(review): read review metadata from one block`.

### Task 3: Records, marker, log sinks

**Files:**
- Create: `src/agent-log.ts`
- Modify: `src/cli.ts` (turn the file sink on for `watch`, `review`, `audit`)
- Test: `src/agent-log.test.ts`

**Interfaces:**
- Consumes: `AgentFailure` (Task 1), `readMetadataBlock` (Task 2). `toRecord` tests build `AgentOutcome` values by hand, since `runAgent` changes in Task 4.
- Produces: `interface AgentRecord { skill: string; attempt: 1 | 2; status: "ok" | "error" | "rate_limited" | "quota_exhausted" | "skipped"; class?: FailureClass; retryable?: boolean; httpStatus?: number; finishReason?: string; errorName?: ErrorName; durationMs?: number; inputTokens?: number; outputTokens?: number }`; `formatAgentsMarker(records: AgentRecord[], pending: string[]): string` returning the whole `<!-- ai-review:agents=<json> -->` line; `parseAgentsMarker(body: string): { records: AgentRecord[]; pending: string[] } | null`; `toRecord(skill: string, attempt: 1 | 2, outcome: AgentOutcome): AgentRecord`; `logAgentRecords(records: AgentRecord[], ctx: { owner: string; repo: string; pr: number; sha: string; provider: string; model: string; messages?: Record<string, string> }): void`; `enableAgentLogFile(path?: string): void` (default `~/.ai-review/logs/agents.jsonl`, overridable with `AI_REVIEW_LOG_FILE`).
- `KNOWN_SKILLS`: the skill file names allowed in a marker, derived from the skills directory listing used by `TIER1_SKILLS` and the Tier 2 detectors, exported for the parser.

- [ ] **Step 1: Write failing tests.** Round trip; unknown skill or error name dropped; values escaped so `-->` cannot appear; oversized list (more than 20 records or 4 KB) keeps every non-ok record and the whole `pending` list and drops `ok` records first; quoted, duplicated and mid-text markers ignored by `parseAgentsMarker`; no `message`, `text`, `response` or `cause` content appears even when the input error carries them; `logAgentRecords` calls `console.log("agent outcome", record)` per record; with the file sink enabled it appends one JSON line per record with `ts`, `owner`, `repo`, `pr`, `sha`, `provider`, `model` and `message` (300 characters at most); disabled means no file; a write error is caught and logged.
- [ ] **Step 2: Run** `pnpm test -- src/agent-log.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the module; keep `enableAgentLogFile` a module-level toggle that only `cli.ts` calls.
- [ ] **Step 4: Run** the same command — expect PASS. **Commit** `feat(review): agent outcome records and markers`.

### Task 4: `runAgent` returns failures and usage; cost counts them

**Files:**
- Modify: `src/review.ts` (`AgentOutcome`, `runAgent`, the totals loop, direct `console.warn/error` lines in the agent path), `src/audit.ts` (its `runAgent` loop and totals)
- Test: `src/review.test.ts`, `src/audit.test.ts`

**Interfaces:**
- Consumes: `classifyAgentError` (Task 1), `toRecord`/`logAgentRecords` (Task 3).
- Produces: `AgentOutcome` variants `ok` gains `durationMs`; `error` becomes `{ status: "error"; failure: AgentFailure; usage?: TokenUsage; durationMs: number }`. `AgentOutcome` is declared in `review.ts`, so `toRecord` (Task 3) takes it as a type-only import.

- [ ] **Step 1: Write failing tests.** A thrown `NoObjectGeneratedError` with `usage` yields an `error` outcome with that usage and the right class; the review's cost totals include it; an aborted agent still returns `skipped` with no usage; every agent failing logs its records before the build throws; all rate limited and all quota exhausted rounds log their records; `audit.ts` totals include failed-attempt usage. Strict fake octokit and model stubs as in existing tests.
- [ ] **Step 2: Run** `pnpm test -- src/review.test.ts src/audit.test.ts -t "agent"` — expect FAIL.
- [ ] **Step 3: Implement.** Map SDK `inputTokens`/`outputTokens` to the existing `promptTokens`/`completionTokens` totals. Log records straight after the agent passes, before any early return or throw. Replace the scattered per-status console lines with the single record log.
- [ ] **Step 4: Run** the full suite once. **Commit** `feat(review): classified agent failures with usage`.

### Task 5: Retry pass

**Files:**
- Modify: `src/review.ts` (the agent pass in `buildReview`), `src/concurrency.ts` only if the pacing hook needs the index-zero change
- Test: `src/review.test.ts` (`describe("agent retry")`)

**Interfaces:**
- Consumes: the first-pass outcomes (Task 4), `computePaceDelayMs`, `capPaceToDeadline`.
- Produces: per agent a list of attempts (`AgentRecord[]`) with `attempt` 1 and 2; a `retrySkipped: string[]` list for agents whose retry was cancelled for time.

- [ ] **Step 1: Write failing tests.** Retryable failure then success merges findings and the records show both attempts; a non-retryable failure calls the model stub once; too little time at collection means no retry and the agent lands in `retrySkipped`; a pacing delay that crosses the threshold cancels the retry (use fake timers); two failures keep the second class; the retry abort signal is built from the original absolute deadline; `lastRateLimit` carries into the retry pass and its first agent is paced; the retry pass does not run its first agent alone.
- [ ] **Step 2: Run** `pnpm test -- src/review.test.ts -t "agent retry"` — expect FAIL.
- [ ] **Step 3: Implement** the retry pass after the first pass, with the eligibility check at collection and again immediately before dispatch.
- [ ] **Step 4: Run** the full suite once. **Commit** `feat(review): retry retryable agent failures once`.

### Task 6: Notice grouping and the `agents` marker in the body

**Files:**
- Modify: `src/review.ts` (`formatReviewBody` partial notice, metadata block, `buildReview` call)
- Test: `src/review.test.ts`

**Interfaces:**
- Consumes: `formatAgentsMarker`, attempts from Task 5.
- Produces: `formatReviewBody` options gain `agentRecords: AgentRecord[]`, `pending: string[]`, `retrySkipped: string[]`.

- [ ] **Step 1: Write failing tests.** Rate-limited and quota-exhausted final outcomes (including a retry that hit a 429 after a retryable first failure) count toward `partial` and appear in the notice. `errored` and `retrySkipped` overlap by design (a retry skipped at collection, at dispatch or by deadline abort leaves the skill in both), so each skill lands in exactly one notice group, never two, and the marker takes the final attempt's record plus the first attempt when it was retried; for a deadline-aborted retry the final outcome is the first attempt's error and the attempt-2 `skipped` record is not the "final" one. Switch the Task 5 tests that read `console.warn("agent retry skipped")` to assert on the body as well. The notice groups as "failed, then recovered on retry", "failed after retry" with class names, "failed, not retried" with class names, "retry skipped, out of time" and the existing "did not run, out of time" line; an all-ok round has no notice; the posted body ends with a metadata block containing one `agents` marker that `parseAgentsMarker` reads back; an approval body carries it too.
- [ ] **Step 2: Run** `pnpm test -- src/review.test.ts -t "partial|agents marker"` — expect FAIL.
- [ ] **Step 3: Implement** the grouped notice and the marker line in the existing marker block.
- [ ] **Step 4: Run** the full suite once. **Commit** `feat(review): group failed agents in the notice and record them in the body`.

### Task 7: Pending coverage

**Files:**
- Modify: `src/review-state.ts` (`ReviewState.incompleteSkills?: string[]`), `src/baseline.ts` (`incompleteSkills` on the derived state, read via `parseAgentsMarker`), `src/review.ts` (scheduling, two user messages, triage SKIP handling, clearing, no silent recovery, KV save)
- Test: `src/baseline.test.ts`, `src/review.test.ts` (`describe("pending coverage")`)

**Interfaces:**
- Consumes: `parseAgentsMarker` (Task 3), the agent attempts (Tasks 5 and 6), `trimPatch` from `src/prompt.ts`.
- Produces: `deriveBaseline(...)` result `state.incompleteSkills: string[]` (empty for bodies without a marker); a helper `wholePrInputComplete(files: PullFile[]): boolean` true only when every file has a patch and none is cut by `trimPatch`.

- [ ] **Step 1: Write failing tests** exactly as the spec's "Pending coverage" test bullet lists: marker to `incompleteSkills`; incremental round gives a pending skill the PR's files and others the delta (assert both user messages); KV round trip; triage SKIP with a pending skill runs only that skill; pending Tier 2 skill runs though the delta would not select it; a skill whose file is gone is dropped; delta-only success, trimmed-patch success and missing-patch success all stay pending while their findings still merge; a clearing round posts although nothing else is new, and the new marker omits the skill, with and without KV; a forced FULL round clears by success; a recovery finding outside the delta keeps its inline anchor; an old body with no marker gives an empty set. Include a loop guard test: a skill that fails again stays pending and the next round retries it once, with no extra round beyond the normal push cadence.
- [ ] **Step 2: Run** `pnpm test -- src/baseline.test.ts src/review.test.ts -t "pending|incompleteSkills"` — expect FAIL.
- [ ] **Step 3: Implement.** Compute pending as (previous pending that still exist and are not cleared) plus (skills that ran or were due and ended non-ok). Schedule pending skills every round with a baseline. Build the second user message only when a pending skill is scheduled on an incremental round. Replace the triage-SKIP early return with a pending-only run when pending is non-empty. Treat a round that clears a skill as non-silent in the silence rule. Save `incompleteSkills` in the KV state.
- [ ] **Step 4: Run** the full suite once. **Commit** `feat(review): re-point incomplete agents at the whole PR`.

### Task 8: Real-GitHub check, docs, gates

**Files:**
- Modify: `CLAUDE.md` (Key files rows for `src/agent-failure.ts`, `src/agent-log.ts`, `src/review-metadata.ts`; the local log file under the CLI notes), `docs/post-mortem-re-review-memory.md` (Prevention bullets on agent failures and partial baselines point at the spec)
- Create: none committed; the check script lives in the scratchpad

- [ ] **Step 1: Real-GitHub check.** A scratchpad script reads the 14 Claude review bodies on joeblackwaslike/stealth-browser#1, joeblackwaslike/ai-listings#74 and joeblackwaslike/agent-skills#10 through `readMetadataBlock` and `parseAgentsMarker` and `deriveBaseline`. Pass criteria: every body is a legacy body or parses; `readMetadataBlock` finds the same sha as the earlier whole-body read for every review; `incompleteSkills` is empty for all 14 (none have the marker); `deriveBaseline` output matches the sprint 3 result. Round-trip the marker through a synthetic body built by `formatReviewBody` and read it back with `gh`-free code.
- [ ] **Step 2: Docs.** Update the two files above in plain prose: no em dashes, no "not X but Y", no colon reveals.
- [ ] **Step 3: Gates.** `pnpm typecheck && pnpm lint && pnpm test`, then build and run `ai-review replay` (check `package.json` scripts and `CLAUDE.md` for the current build and run commands); expect green and the recycled counts unchanged (1, 0, 0, 0, 2, 4).
- [ ] **Step 4: Commit** `docs: describe agent outcome logs and retry`.
