# Candidate F1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `f1` strategy to the experiments harness: a triage call picks operation ids, then a spend-matched reviewer gets the full matching runbook entries.

**Architecture:** `f1-runbooks.ts` parses the operation entries into kept text per id. `f1.ts` makes one triage call per cell, then runs the shared spend-matched loop in `spend-matched.ts` with the selected entries passed as the custom prompt. A pilot plan holds `a`, `f0` and `f1`.

**Tech Stack:** TypeScript ESM, Vitest, Biome, zod, the AI SDK `generateObject`. Run from the repo root with pnpm and Bun; test with `node_modules/.bin/vitest run <file> --reporter=basic`.

**Spec:** docs/superpowers/specs/2026-11-21-candidate-f1-design.md

## Global Constraints

- No inline comments, banner comments or commented-out code; docstrings only on public exports.
- Named exports only; imports use `.js` extensions.
- `a0`'s behavior and `f0`'s behavior must not change except where this plan says so; `a0.test.ts`, `f0.test.ts` and `spend-matched` callers keep passing.
- Message ref for `f1` is exactly `replay-f1`; usage and agent-review labels are `f1-run-N`; the triage usage key is `f1-triage.md`.
- Triage output is recorded as one `toolCalls` entry named `triage:` followed by the comma-joined ids (for example `triage:REL-01,DEL-02`).
- The kept text of an entry is its `##` heading plus the sections `What not to spend review on`, `Checklist` and `Red flags`, in file order.
- `skills/f1-runbook-reviewer.md` copies `a0`'s "Severity, Fields, and Suggestions" and "What to look for" sections verbatim.
- Triage failure (non-ok outcome or invalid object) falls back to the general list and is recorded as `triage:none`; it never throws.
- No OpenAI call anywhere; the pilot plan lists only `anthropic` as provider.
- Nothing is run against a model in this plan; the pilot run happens after merge, from the lock.

## Review Focus

- A diff matching no operation (triage returns an empty list or only unknown ids) still gets the general review and a `triage:none` record.
- An entry file with a heading that is not an operation id (the template, prose headings) yields no entry and no crash.
- The same id returned twice by triage injects its entry once.
- Triage returning more than 4 ids injects at most the first 4 valid ones.
- A triage failure on the first repeat does not abort the cell; later repeats reuse the same selection.

---

### Task 1: Runbook entry parser

**Files:**
- Create: `src/replay/strategies/f1-runbooks.ts`
- Test: `src/replay/strategies/f1-runbooks.test.ts`

**Interfaces:**
- Produces: `parseEntries(markdown: string): Map<string, string>`, `loadEntries(dir?: string): Map<string, string>` (reads every `*.md` in `docs/review-ontology/operations/` except `_template.md`), `selectEntries(entries: Map<string, string>, ids: string[]): string` (kept text of known ids in order, deduplicated, at most 4, joined by a blank line, `""` when none), and `entryHeadings(entries: Map<string, string>): { id: string; name: string }[]`, the id and name pairs the triage prompt lists.

- [ ] **Step 1: Write the failing tests** in `f1-runbooks.test.ts`: `loads all 60 operation ids from the committed entry files`; `keeps only the heading, What not to spend review on, Checklist and Red flags` (parse a small fixture string with all eleven sections, assert the kept text contains those four and none of "Worked example", "Eval seed", "Context to gather"); `ignores a heading that is not an operation id`; `selectEntries drops unknown ids, deduplicates and caps at 4`; `selectEntries returns the empty string when nothing matches`; `entryHeadings returns id and name for REL-01`.
- [ ] **Step 2: Run to verify they fail** (module not found).
- [ ] **Step 3: Implement** the functions above in `f1-runbooks.ts`. An entry starts at `^## [A-Z]{3}-\d{2}: ` and ends before the next `^## `; sections split on `^### `.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `feat(replay): parse the operation entries for f1`.

### Task 2: F1 skill files

**Files:**
- Create: `skills/f1-runbook-reviewer.md`, `skills/f1-triage.md`
- Test: `src/replay/strategies/f1-skills.test.ts`

**Interfaces:**
- Consumes: `skills/a0-single-reviewer.md` sections, `skills/f0-runbook-reviewer.md` triage table.
- Produces: the two files; `f1-triage.md` ends with a line `Operations:` after which the runtime appends the id and name pairs.

- [ ] **Step 1: Write the failing tests** in `f1-skills.test.ts`: `copies the a0 severity section verbatim`; `copies the a0 general checklist verbatim`; `says a check needing information outside the diff is skipped, never asked` (skill contains "outside the diff" and "skip"); `says the entries below add to the general list and that skip clauses bind`; `the triage skill carries all 16 diff-shape rows of the f0 triage table` (every table row of f0's `| Diff shape | Operations |` table appears in the triage skill); `the triage skill asks for ids only and at most 4`; `the reviewer skill has no operation lines and no triage table` (no line starting with `REL-01 `).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Write both skill files.** The reviewer skill is the `a0` header and general list verbatim, then one short section stating the entries that follow in Custom Instructions are the operations this diff performs, each adds to the general list, a skip clause is binding, a check needing information outside the diff is skipped, operation ids go at the end of a finding's `body` and never in `title`, then the `a0` Confidence section. The triage skill states the task (name the operations the diff performs, ids only, at most 4, none when nothing matches), holds the 16-row table copied from the f0 skill, and ends with the line `Operations:`.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `feat(replay): f1 reviewer and triage skills`.

### Task 3: The `f1` strategy

**Files:**
- Create: `src/replay/strategies/f1.ts`
- Modify: `src/replay/strategies/spend-matched.ts`, `src/replay/strategies/index.ts`, `src/replay/experiment/spend-matched-names.ts`
- Test: `src/replay/strategies/f1.test.ts`; extend `src/replay/experiment/runner.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 exports; `runSpendMatched(input, config)`, `estimateSpendMatched` from `spend-matched.ts`; `resolveJudgeRole` from `src/roles.ts`; `createAIModel`, `outputBudget`, `reasoningProviderOptions`, `resolveSelectionAuth`/`resolveAuth` as `src/replay/adjudication/model-judges.ts` uses them; `computeCost` for the triage cost.
- Produces: `F1_IMPLEMENTATION_REVISION = 1`, `strategyF1Version(readSkill: (name: string) => string, entriesHash: string, revision?: number, a0Revision?: number): string`, `strategyF1: ReviewStrategy` (name `f1`), `triage(input: StrategyInput, entries): Promise<{ ids: string[]; costUsd: number; wallMs: number; usage }>`; `SpendMatchedConfig` gains `customPrompt?: string` (passed to `runAgent`'s third positional argument, default `""`), and `runSpendMatched` gains an optional second result piece: `extraUsage?: RoundUsage` and `extraToolCalls?: ToolCallRecord[]` in its config so `f1` can add the triage usage and tool call without changing `a0` or `f0`.

- [ ] **Step 1: Write the failing tests.** `f1.test.ts` (mock `runAgent` and the triage call as `f0.test.ts` mocks `runAgent`): `runs one triage call then reviews with exactly the selected entries in the custom prompt`; `triage returning an unknown id or nothing runs the general list and records triage:none`; `triage returning a failure falls back and records triage:none`; `triage runs once and every repeat reuses the selection`; `usage holds f1-triage.md and f1-run-N.md keys and the spend counts the triage cost`; `toolCalls has one triage entry naming the ids`; `uses ref replay-f1`; `version changes with the skill text, the triage skill, the entries hash and the revision`; `registers alongside a, a0 and f0`. In `runner.test.ts`: `f1 requires a and receives a's spend as its target`. `spend-matched` tests stay green unchanged (assert `a0.test.ts` and `f0.test.ts` pass).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** `spend-matched.ts`: add `customPrompt`, `extraUsage` and `extraToolCalls` to `SpendMatchedConfig` (all optional; `a0` and `f0` pass none) and merge them into the result's `usage`, `toolCalls` and the `achievedUsd` calculation. `f1.ts`: build the triage prompt from `skills/f1-triage.md` plus the diff and the id and name pairs, call `generateObject` with schema `{ operations: string[] }`, drop ids not in the entry map, keep at most 4, price the call with `computeCost`; on any failure return no ids; then call `runSpendMatched` with skill `f1-runbook-reviewer.md`, label `f1`, ref `replay-f1`, `customPrompt` set to the selected entries, and the triage usage and tool call as extras. `spendTargetUsd` for the review loop is the input's target minus the triage cost, floored at zero. Add `f1` to `isSpendMatched` and register `strategyF1` in `index.ts`. Compute `entriesHash` as the sha256 of the sorted entry file contents.
- [ ] **Step 4: Run to verify they pass**, then `node_modules/.bin/tsc --noEmit` and `node_modules/.bin/vitest run src/replay --reporter=basic`.
- [ ] **Step 5: Commit** `feat(replay): strategy f1, triage then the full matching runbooks`.

### Task 4: Pilot plan, pins and protocol

**Files:**
- Create: `docs/review-experiments/plan-pilot-f1.json`, `docs/review-experiments/plan-pilot-f1.lock`
- Modify: `docs/review-experiments/plan.json`, `docs/review-experiments/plan-chained.json`, `docs/review-experiments/protocol.md`, `src/replay/strategies/versions.test.ts`

**Interfaces:**
- Consumes: `strategyF1.version`, `strategyF0.version` (pinned at `c6649c4124ef`), the pilot fixtures and settings of `plan-pilot-f0r.json`.
- Produces: a locked pilot plan with strategies `a`, `f0`, `f1`.

- [ ] **Step 1: Extend `versions.test.ts`** with `strategy f1 matches plan.json` and keep the chained-plan equality test; run it and watch it fail on the missing pin.
- [ ] **Step 2: Add `f1`** with its computed version to `plan.json` and `plan-chained.json` (both stay `"draft": true`). Create `plan-pilot-f1.json` from `plan-pilot-f0r.json` with strategies `a`, `f0` (version `c6649c4124ef`), `f1`, and a `selectionRule` saying the 14 tuning fixtures, Anthropic only, strategies a, f0 and f1. Run `node_modules/.bin/biome format --write` on the new file.
- [ ] **Step 3: Print the plan hash** with `bun src/cli.ts replay --experiment plan --plan-file docs/review-experiments/plan-pilot-f1.json`, write it with a trailing newline to `plan-pilot-f1.lock`, and re-run to confirm the same hash prints and nothing runs. Record the printed cell count and estimate in the PR body.
- [ ] **Step 4: Add a paragraph to `protocol.md`** on `f1`: the triage call and its cost accounting, the kept entry sections, that it runs after `a`, the triage record in `toolCalls`, and the stop rule from the spec verbatim.
- [ ] **Step 5: Run** `node_modules/.bin/tsc --noEmit`, `node_modules/.bin/biome check .`, and the full `node_modules/.bin/vitest run --reporter=basic`; all pass.
- [ ] **Step 6: Commit** `feat(replay): f1 pilot plan, pins and protocol`.
