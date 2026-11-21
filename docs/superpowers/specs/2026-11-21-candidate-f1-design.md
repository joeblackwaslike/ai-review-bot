# Candidate F1: triage, then the full matching runbooks

Second testable slice of candidate F ([process-design.md section 5a](../../review-ontology/process-design.md)). It adds one strategy, `f1`, to the experiments harness ([2026-11-05-review-experiments-harness-design.md](2026-11-05-review-experiments-harness-design.md)), after F0 ([2026-11-14-candidate-f0-design.md](2026-11-14-candidate-f0-design.md)).

## Intent

F0 gave one reviewer a distilled digest of the 60 operation entries. At equal spend on the 14 tuning fixtures it tied the production pipeline `a`: precision 0.548 against 0.541 and recall 0.263 against 0.276, with 14 PRs and most verdicts single-family. Restoring `a0`'s general checklist did not change that, and a single `f0` call yields about as many findings as one agent in `a`.

That leaves the runbooks untested. The digest is about 11 KB hand-distilled from about 300 KB, so a tie may mean the idea is flat or may mean the distillation dropped what mattered. F1 injects the full entries for the operations a diff performs and nothing else, so the only change from F0 is how much runbook text the reviewer gets and how it is chosen.

## Goals

- A registered strategy `f1` the harness runs like any other.
- One pilot plan holding `a`, `f0` and `f1` on the 14 Anthropic tuning fixtures, so `f1` and `f0` run under identical conditions.
- A written stop rule, fixed before the run, for what the result means.

## Non-goals and anti-goals

- No scanners, subagents, diff splitting or tool loop. Those are F2 and later.
- No OpenAI run. The quota is nearly exhausted, and this is a tuning-split pilot.
- No `score --final` and no test-split cells.
- Tuning the entries or the triage prompt after seeing pilot results and re-running on the same fixtures is an anti-goal. A change means a new version, and conclusions come from the validation split.

## Approaches considered

1. Triage call, then a review call with the matching full entries (picked). A cheap model picks operation ids. The reviewer prompt carries those entries. It changes one thing against F0 and needs no harness support beyond a second model call.
2. One call with a `get_runbook(id)` tool. Closer to F, since the model picks its own runbooks, but it needs tool-call support in the harness and mixes selection with injection. Deferred.
3. Rule-based triage, then injection. Deterministic and cheap, but F says the model detects the operation, and it would test injection alone.

## Design

- `skills/f1-runbook-reviewer.md`: `a0`'s severity, fields and suggestions section and its "What to look for" list, verbatim, then a short section saying the entries below are the operations this diff performs, that each adds to the general list, and that an entry's skip clause is binding. No digest, no triage table.
- `src/replay/strategies/f1-runbooks.ts`: `parseEntries(markdown)` reads each family file under `docs/review-ontology/operations/` into `Map<id, text>`, an entry being one `## XXX-NN` heading up to the next. The text kept per entry is its heading plus the "What not to spend review on", "Checklist" and "Red flags" sections, the same three the F0 digest drew from. The rest (signals, context to gather, worked example, tool and eval notes) is dropped, because the reviewer has no tools and the entries tell a reviewer with tools to run them. `selectEntries(ids)` returns the kept text of known ids in the order given and drops unknown ones.
- Triage call, once per cell: one `generateObject` call on the classifier role's model (`resolveJudgeRole`, Haiku at low effort by default). Its prompt is the diff plus `skills/f1-triage.md`, which holds the 16-row diff-shape table (copied from `skills/f0-runbook-reviewer.md`, so editing F0 never changes F1) and the instruction to answer with ids only, followed by the 60 id and name pairs read from the entry files. Its schema is `{ operations: string[] }` with at most 4 ids. Ids not in the entry map are dropped. If none remain, the review runs with the general list only and the cell records that no entry matched.
- Review calls: the shared spend-matching loop in `src/replay/strategies/spend-matched.ts` runs the reviewer repeatedly to `a`'s spend, as `f0` does. `SpendMatchedConfig` gains an optional `customPrompt`, which `runAgent` already appends to the system prompt, and `f1` passes the selected entries there. Triage runs once and every repeat reuses its selection. The message ref is `replay-f1`, so the prompt cache does not cross with other strategies.
- The triage output is recorded as one `toolCalls` entry named `triage:` followed by the chosen ids (for example `triage:REL-01,DEL-02`), with its wall time and cost, so adjudication can read what was selected without a new result field.
- Cost: the triage call's usage is recorded under `f1-triage.md` and counts toward the cell's spend and the per-cell cap, so `achievedUsd` is honest. The spend target is `a`'s cost for the round, and review calls fill what triage leaves.
- `skills/f1-runbook-reviewer.md` also tells the reviewer that a check needing information outside the diff is skipped, never reported as a question, as F0's digest does.
- `strategyF1Version` hashes the skill text, `skills/f1-triage.md`, the content of the six entry files, the tier maps, `F1_IMPLEMENTATION_REVISION` and the spend-matched revision, so editing an entry makes stored cells stale.
- Register `f1` in `src/replay/strategies/index.ts`. `isSpendMatched` in `src/replay/experiment/spend-matched-names.ts` gains `f1`, so the runner runs it after `a` and gives it `a`'s spend as its target.
- `docs/review-experiments/plan-pilot-f1.json` and its lock: the pilot fixtures with strategies `a`, `f0` (at its current pinned version) and `f1`. The full `plan.json` and `plan-chained.json` gain `f1`, stay `draft`, and get no lock.
- `protocol.md` gets a paragraph on `f1`, the triage call's cost accounting and the stop rule.

## Stop rule (fixed before the run)

Compared at equal spend on the pilot, adjudicated Anthropic-only, `f1` against `f0`:

- Proceed to the validation split if `f1` recall is at least 3 points above `f0` and precision is not lower by more than 3 points. Full runbooks then help, and the validation split with its 17 PRs is the first run that can separate them.
- Stop injecting runbooks if `f1` is within 3 points of `f0` on both, or below. If `f0` and `f1` both stay level with `a`, the runbooks add nothing at this spend, and the next candidate should change something else, such as scanners or diff splitting.
- The pilot has 14 PRs and carries no verdict. These rules only decide what to spend next.

## What is left to the builder

- The wording of `skills/f1-triage.md` outside its table, within the schema above.
- How `parseEntries` handles the template file and any heading that is not an operation id.
- Whether triage failure (a non-ok outcome or an invalid object) throws or falls back to the general list. Preferred: fall back and record it, since a failed triage is a property of `f1` and should not leave a hole in the grid.

## Risks

- A wrong triage sends the reviewer the wrong entries, and a loss would then say more about the classifier than about runbooks. The stored triage output per cell lets adjudication check this afterward.
- Full entries are long (up to about 10 KB each), so spend matching gives `f1` fewer repeats than `f0` at the same spend. That trade, fewer repeats for more guidance, is what the pilot tests.
- The scorer pairs each strategy against `a`, so `f0` against `f1` is read from two paired results and not directly.
- Fixture labels and adjudication verdicts are provisional until a cross-model check, and the OpenAI cross-check is out of reach, so most verdicts stay single-family.

## Verification

- `f1` is registered and appears in `strategyNames()`, and the runner requires `a` in a plan that holds it.
- `parseEntries` returns all 60 ids from the committed entry files, and `selectEntries` drops an unknown id.
- `strategyF1Version` changes when the skill text, `skills/f1-triage.md` or an entry file changes.
- `parseEntries` keeps only the three named sections of an entry.
- A mocked triage returning ids produces a review prompt containing exactly those entries, and one returning nothing produces the general list only.
- Triage usage appears in the cell's usage and counts toward its spend.
- `--experiment plan` on the pilot plan lists the three strategies with a cost estimate and runs nothing.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
