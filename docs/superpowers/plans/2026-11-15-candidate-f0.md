# Candidate F0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register a strategy `f0` (one reviewer, one call, operation-aware digest prompt) and add it to the two draft experiment plans.

**Architecture:** `f0` mirrors `strategyA0` in [src/replay/strategies/a0.ts](../../../src/replay/strategies/a0.ts) with no repeat loop. Its prompt is a new skill file, `skills/f0-runbook-reviewer.md`, which is the `a0-single-reviewer.md` header plus a distilled digest of `docs/review-ontology/triage.md` and `docs/review-ontology/operations/*.md`.

**Tech Stack:** TypeScript ESM, Vitest, Biome, pnpm.

**Spec:** docs/superpowers/specs/2026-11-14-candidate-f0-design.md

## Global Constraints

- TypeScript ESM; imports use `.js` extensions; named exports only; no default exports.
- Biome formatting (tabs); `pnpm typecheck`, `pnpm lint`, `pnpm test` must pass. Run vitest with `--reporter=dot` or `--reporter=verbose`; the hook rejects a bare `vitest run`.
- No inline comments unless there is no better way; no ASCII banner comments.
- `f0` runs exactly one `runAgent` call per round. It ignores `spendTargetUsd` and `tolerance`.
- The digest is at most 12,000 bytes.
- `plan.json` and `plan-chained.json` stay `"draft": true`; do not create or commit any `.lock` file; do not run `--experiment run` or any model-calling command.
- Tests mock `runAgent` and auth as `a0.test.ts` does. They never call a model.

## Review Focus

- A digest that omits an operation id, so findings cannot be traced to it. Test: every `## XXX-NN:` heading id in `docs/review-ontology/operations/*.md` appears in the digest.
- `plan.json` pinning a stale `f0` version after the digest changes. Test: `versions.test.ts` pins `f0` like `a` and `a0`.
- `f0` repeating runs when a spend target is set. Test: one `runAgent` call with `spendTargetUsd` set to ten times one run.
- A failed first call returning an empty review. Test: `f0` throws on a non-ok outcome, as `a0` does.
- A digest over budget crowding out the diff. Test: byte-size ceiling.

---

### Task 1: Digest skill file

**Files:**
- Create: `skills/f0-runbook-reviewer.md`
- Create: `src/replay/strategies/f0-digest.test.ts`

**Interfaces:**
- Consumes: `skills/a0-single-reviewer.md` (copy its frontmatter shape and its "Severity, Fields, and Suggestions" section verbatim; change only `name` to `f0-runbook-reviewer` and `description`); `docs/review-ontology/triage.md` and `docs/review-ontology/operations/*.md` (read, never edited).
- Produces: `skills/f0-runbook-reviewer.md`, at most 12,000 bytes, with a triage table (diff shape to operation ids) and one or two checklist lines per operation id, distilled from each entry's Checklist, Red flags and "What not to spend review on" sections. The "What to look for" section of the a0 skill is replaced by the digest. The confidence rule (only findings at 0.8 or above) stays.

- [ ] **Step 1: Write the failing test** in `f0-digest.test.ts`: read the skill file and `operations/*.md` (excluding `_template.md`); collect every id matching `^## ([A-Z]+-\d+):` ; assert each id appears in the skill text, the skill is at most 12,000 bytes, and the text still contains the severity scale heading `### Severity scale (P0–P3)` and the string `confidence ≥ 0.8` or the equivalent sentence copied from the a0 skill.
- [ ] **Step 2: Run** `pnpm vitest run src/replay/strategies/f0-digest.test.ts --reporter=dot`. Expected: FAIL, skill file missing.
- [ ] **Step 3: Author `skills/f0-runbook-reviewer.md`.** Read every operations file and `triage.md`; write the digest by hand. Keep each operation to one or two lines naming what to check and what not to spend review on. Do not paste whole entries.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): f0 runbook digest skill`.

### Task 2: The f0 strategy

**Files:**
- Modify: `src/replay/strategies/a0.ts` (export `selectionFor` and `oneRunEstimate`; no behavior change)
- Create: `src/replay/strategies/f0.ts`
- Create: `src/replay/strategies/f0.test.ts`
- Modify: `src/replay/strategies/index.ts` (register `strategyF0`)

**Interfaces:**
- Consumes: `selectionFor(input: StrategyInput)` and `oneRunEstimate(input: StrategyInput): number | undefined` from `a0.ts`; `runAgent`, `resolveSelectionAuth`, `buildAuditUserMessage`, `toLiveFindings`, `requireCost`, `roundCostUsd`, `legacyTierMap` as `a0.ts` uses them.
- Produces: `export const F0_IMPLEMENTATION_REVISION = 1`; `export function strategyF0Version(readSkill: (name: string) => string, revision?: number): string` (12 hex chars, sha256 over the skill text, both legacy tier maps and the revision); `export const strategyF0: ReviewStrategy` with `name: "f0"`, `needsCheckout: false`, lazy cached `version`, `estimateCost` equal to `oneRunEstimate`, and `run` that makes one `runAgent("f0-runbook-reviewer.md", context, selection, "", { auth, abortSignal: signal })` call.

- [ ] **Step 1: Write the failing tests** in `f0.test.ts`, mocking `runAgent` and auth as `a0.test.ts` does. Cases: name `f0`, no checkout, version matches `/^[0-9a-f]{12}$/`; version changes with skill text and with revision; `run` calls `runAgent` once with `f0-runbook-reviewer.md` even when `spendTargetUsd` is ten times one run; result has `agentReviews` of length 1 with skill `f0`, usage keyed `f0.md`, findings through `toLiveFindings`, `spend` undefined; `run` throws `f0 run failed: <status>` on a non-ok outcome; `estimateCost` equals one `a0` run's estimate for the same input; after `registerBuiltinStrategies()`, `strategyNames()` includes `a`, `a0` and `f0`.
- [ ] **Step 2: Run** `pnpm vitest run src/replay/strategies/f0.test.ts --reporter=dot`. Expected: FAIL, `f0.js` missing.
- [ ] **Step 3: Implement** `strategyF0Version` and `strategyF0` in `f0.ts`, exporting the two helpers from `a0.ts` and importing them. On a non-ok first outcome throw; otherwise build `usage`, `achievedUsd` is not needed since `spend` is omitted.
- [ ] **Step 4: Register** `strategyF0` in `index.ts`.
- [ ] **Step 5: Run** `pnpm vitest run src/replay/strategies --reporter=dot`. Expected: PASS, including the existing `a0` tests.
- [ ] **Step 6: Commit** `feat(replay): strategy f0, one reviewer with the runbook digest`.

### Task 3: Plan wiring and docs

**Files:**
- Modify: `docs/review-experiments/plan.json`, `docs/review-experiments/plan-chained.json` (add `{ "name": "f0", "version": "<strategyF0.version>" }` to `strategies`; both stay draft)
- Modify: `src/replay/strategies/versions.test.ts` (pin `f0` to `plan.json`)
- Modify: `docs/review-experiments/protocol.md` (one short paragraph: `f0` is the first candidate-F slice; it needs no `a` pairing, it is scored against baseline `a` like `a0`, and its version changes whenever the digest changes, so re-pin it in both plan files)

**Interfaces:**
- Consumes: `strategyF0.version` from Task 2 (compute with a one-off `bun -e` import, or read it from the failing `versions.test.ts` output).
- Produces: both plan files pin the same `f0` version that `strategyF0.version` returns.

- [ ] **Step 1: Add the failing case** to `versions.test.ts`: `it("strategy f0 matches plan.json", ...)`.
- [ ] **Step 2: Run** `pnpm vitest run src/replay/strategies/versions.test.ts --reporter=dot`. Expected: FAIL, no `f0` entry.
- [ ] **Step 3: Edit both plan files** with the real version string, and edit `protocol.md`.
- [ ] **Step 4: Verify.** Run `pnpm vitest run src/replay/strategies/versions.test.ts --reporter=dot` (PASS), then `bun src/cli.ts replay --experiment plan --plan-file docs/review-experiments/plan.json`. Expected: the output lists `f0` cells and a cost estimate, and spends nothing. Paste the estimate into the report.
- [ ] **Step 5: Run** `pnpm typecheck && pnpm lint && pnpm test`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(replay): pin f0 in the draft experiment plans`.
