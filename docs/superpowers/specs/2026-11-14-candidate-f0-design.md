# Candidate F0: one reviewer with a distilled runbook digest

Spec for the first testable slice of candidate F ([process-design.md section 5a](../../review-ontology/process-design.md)). It adds one strategy to the experiments harness ([2026-11-05-review-experiments-harness-design.md](2026-11-05-review-experiments-harness-design.md)) so the existing plan can compare the current pipeline against Joe's idea.

## Intent

The grid as planned compares `a` (production, Tier 1 and Tier 2 agents) with `a0` (one plain reviewer, spend-matched to `a`). `a0` is a control. Nothing in the plan tests candidate F, because F has no strategy to register.

F bundles four changes: one agent instead of five, runbooks instead of skill prompts, scanners as evidence, and diff splitting. If the bundle wins or loses, nothing says which change did it. F0 is the smallest slice that tests the first two together.

## Goals

- A registered strategy `f0` that the harness runs like any other.
- A measured answer to whether a single reviewer given operation-aware guidance matches or beats the tiers at a lower cost per round.
- One locked plan holding `a`, `a0` and `f0`, run once.

## Non-goals and anti-goals

- No scanners, no subagents, no diff splitting, no triage call. Those are F1 and later.
- No spend matching. `f0` runs once per round and is judged at its own cost, shown next to `a` and `a0`. "Same quality for less money" is the claim being tested.
- Running `a` and `a0` before `f0` exists is an anti-goal. `planHash` covers `strategies` ([plan.ts:97](../../../src/replay/experiment/plan.ts)), so a plan without `f0` has a different hash and its results cannot be reused.

## Approaches considered

1. **One prompt, one call, distilled digest (picked).** A new skill file holds the triage table and per-operation checklist lines. It mirrors `a0`, so the build is small and the only difference from `a0` is the prompt.
2. **Triage call, then a runbook call.** The first call classifies the PR and the second gets only the matching full runbook. It tests runbook selection, which is central to F, but it costs another call and mixes two changes. Deferred to F1.
3. **Option 1 repeated to match `a`'s spend.** Gives a like-for-like spend comparison but hides the cost advantage. Rejected.

Inlining the full runbooks was dropped: the six operations files and `triage.md` total about 331 KB (roughly 80k tokens), against 55 lines for the `a0` skill.

## Design

- `skills/f0-runbook-reviewer.md`: the `a0-single-reviewer.md` header (severity scale, required fields, suggestion rules) unchanged, with its "What to look for" section replaced by the digest.
- The digest is about 10 KB. It has a triage table that maps diff shapes to operation ids, then one or two checklist lines per operation taken from each entry's Checklist, Red flags and "What not to spend review on" sections in [operations/](../../review-ontology/operations/).
- `src/replay/strategies/f0.ts`: `strategyF0`, modeled on `strategyA0`. It makes one `runAgent` call with the same model routing, auth and message builder, and returns the findings, usage and an `agentReviews` list of one. `estimateCost` is the single-run estimate. A `strategyF0Version` hash covers the skill file, the tier maps and an implementation revision, so editing the digest makes stored cells stale.
- Register `f0` in `src/replay/strategies/index.ts`.
- Add `f0` to the `strategies` list in `docs/review-experiments/plan.json` and `plan-chained.json`. Both stay `draft`, so no lock is committed and nothing runs from this branch.

## What is left to the builder

- Writing the digest. The choices are which operations get a line and how each entry is compressed. The digest keeps ids so findings can later be traced to an operation.
- The exact `spend` field values `f0` reports, within the existing `StrategyResult` type.

## Risks

The digest is hand-distilled. If F0 loses, the idea may have failed or the distillation may have dropped the useful parts. F1 injects full runbooks and is the check on that.

F0 also drops a0's generic "What to look for" list, so a loss could come from that removal and not only from the runbooks.

## Verification

- `f0` is registered and appears in `strategyNames()`.
- `strategyF0Version` changes when the skill text changes.
- One `run` returns one agent review, usage for one call, and findings through `toLiveFindings`.
- `--experiment plan` on the edited plan lists `f0` with a cost estimate and runs nothing.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.
