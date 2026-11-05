# Review process design

The current pipeline wasn't designed. It came out of a quick research pass: five checklist
personas read the same diff in parallel, a few more join when path and keyword detectors fire,
and a merge layer combines what they say. This document audits that pipeline against the
review process in [Joe's guide](../Code-Review-Guide-and-Playbooks.md#how-to-run-a-review),
describes the process a senior reviewer follows, lays out candidate architectures, and plans
the experiments that choose between them.

Nothing here is decided. The recommendation at the end is a hypothesis for the experiments to
confirm or reject.

## 1. Today's pipeline, end to end

| Stage | Code | Decides | Sees | Doesn't see |
| --- | --- | --- | --- | --- |
| Trigger | `api/github/webhook*`, `src/scheduler.ts` | Whether and when to review | The webhook event | |
| Re-review triage | `src/triage.ts` | SKIP, INCREMENTAL or FULL; which earlier findings are resolved | The delta, the open findings, renames | The repo |
| Tier | `classifyTier()` in `src/router.ts` | Model and effort for every agent | Line counts, file paths, labels | What the change is |
| Packing | `packDiff()` in `src/diff-pack.ts` | What part of the diff fits in 200k characters | Patches | Moves, renames, file roles; deletion-only hunks dropped under pressure |
| Tier 1 agents | `runAgent()` in `src/review.ts` | Findings, five times over, from five personas | PR title and body, the packed diff | Files, references, history, CI, the ticket, the repo's instructions |
| Tier 2 detection | `detectTier2Skills()` in `src/tier2.ts` | Which of four extra personas run | Paths and patch keywords | Same as packing |
| Merge | `mergeReviews()`, `src/claim-dedupe.ts`, `src/advisory.ts` | One review out of many | All agents' findings | Whether any finding is true |
| Memory | `src/ledger/`, `src/baseline.ts` | What not to repeat; what still blocks | Earlier reviews and threads | |
| Anchoring | `buildReviewComments()` | Which comments can post inline | The full patches | |
| Post | `maybeSubmitReview()` | The verdict | The merged result | |

Most of the code after the agents exists to clean up what the agents produce: dedupe,
restatement collapsing, ledger suppression, a retraction rule that is off because it keeps
misfiring, advisory caps. Each of those is a fix applied downstream for a problem created
upstream: agents that know too little and overlap too much.

## 2. Scored against the guide's process

The guide's [How to run a review](../Code-Review-Guide-and-Playbooks.md#how-to-run-a-review)
section and its checklist give the steps. How today's pipeline does each:

| Guide step | Today | Gap |
| --- | --- | --- |
| Restate the intent; read the spec or ticket first | The PR body is in the prompt. The linked ticket and spec aren't fetched | No intent step. A PR without stated intent gets a full review, not a question |
| Let CI go first | CI results aren't read | Agents comment on things the type checker or tests already caught, or miss that tests fail |
| Size the change, split along a seam | Lines changed | No idea of operations or roles ([triage.md](triage.md)) |
| Separate mechanical edits | Not detected | Reformat and rename noise is reviewed as code ([operations/mechanical.md](operations/mechanical.md)) |
| Read the tests first | One persona looks at tests | Tests aren't used as the statement of intent |
| List the new public surface | Not done | No compatibility pass unless a persona notices |
| Pick the playbooks | Regex detectors pick personas | Personas are generic checklists, not the guide's playbooks |
| Review in order: scope, design, correctness, readability | All personas at once | No design-first pass; line comments arrive on code that should be restructured |
| Review locally | Diff only | No references, no blame, no surrounding file ([reviewer-tools.md](reviewer-tools.md)) |
| Ask before asserting when context is missing | Not possible | With no way to look, agents assert |
| Group findings, label what blocks, approve improvements | Merge layer, P0–P3, event rule | Severity tracks model confidence, not impact (see evidence) |

## 3. What the evidence says

Measured, not guessed. Sources are in the linked documents.

- **Precision is low on the Anthropic side.** Over three PRs checked by hand, Anthropic-side
  findings were right 9 of 42 times; OpenAI-side, 39 of 47 (recorded in the repo's agent
  instructions).
- **A third of findings are restatements.** In a replay of 28 PRs, 403 of 1,180 Anthropic
  findings (34%) collapsed as near-duplicates
  ([post-mortem-reviewer-hallucinations.md](../post-mortem-reviewer-hallucinations.md)). That
  is the cost of five agents reading the same input.
- **Later rounds find almost nothing real.** On PR #43, rounds 1–2 produced 13 real defects in
  72 findings; rounds 3–4 produced 0 in 48. On PR #45, round 3 produced 0 in 12 (same source).
- **Severity is inverted.** High-severity findings were useful 8% of the time, medium-severity
  58% (issue #38, same source).
- **Persona prompts carried false premises.** `silent-failure-hunter.md` was vendored with
  another project's Sentry and Statsig setup stated as fact, and both bots recycled a
  "bypasses Sentry" finding for six rounds (same source).
- **Replay join rate is near zero out of sample.** On the held-out ai-listings#50 fixture,
  0 of 15 Anthropic candidates and 0 of 5 OpenAI candidates matched a labelled claim (the
  replay section of the repo's agent instructions). Either the reviewers miss what humans
  flagged, or the matcher is too strict; both need fixing before any experiment's numbers
  mean much.
- **Repeats of answered findings.** Reviewers re-raised findings the author had already
  rejected, because they had no memory of replies
  ([post-mortem-re-review-memory.md](../post-mortem-re-review-memory.md)). The ledger fixed the
  memory; it can't fix a reviewer that can't check whether the author was right.

What the evidence points at: agents that can't look anything up, overlapping on one input,
with nothing checking their claims before they post.

## 4. The target process

A senior reviewer's process as steps with inputs and outputs, taken from the guide. Each step
names the part of this folder that defines it.

| # | Step | Input | Output | Defined in |
| --- | --- | --- | --- | --- |
| 1 | Intent | PR body, linked ticket or spec, agent instructions | One-sentence intent, requirements list, or "ask for intent" | [reviewer-tools.md](reviewer-tools.md) (`linked_work_item`, `agent_instructions`) |
| 2 | Classify | PR files, diff, moved-code detection | Operations per hunk, domains per file, file roles | [operations/](operations/), [domains.md](domains.md) |
| 3 | Plan | Classification, CI results, size | Depth, which passes, in which order; design-first or full | [triage.md](triage.md) |
| 4 | Gather context | The plan | References, surrounding code, blame, history, CI annotations | [context-building.md](context-building.md) |
| 5 | Review by concern | Narrowed or widened scope, context, the matching playbooks | Candidate findings, each with its evidence | The guide, plus each operation's checklist |
| 6 | Verify | Each candidate and its evidence | Confirmed, downgraded to a question, or dropped | The guide's "ask before asserting" rule |
| 7 | Write | Confirmed findings | Summary first, grouped findings, labels, verdict | The guide's [Writing the review](../Code-Review-Guide-and-Playbooks.md#writing-the-review) |

Steps 1–4 happen before any finding exists. Today's pipeline has no step 1, a line-count
version of step 3, and no steps 2, 4 or 6.

## 5. Candidate architectures

| | Shape | Maps to the target | Cost and latency | Prompt cache | Main risk | Testable with replay |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | Today: tiered personas in parallel on one input, then merge | Step 5 only, five times | Known: about 75s for a 14-file diff at concurrency 4 | Good: shared prefix | Overlap, unchecked claims | Yes, today |
| **B** | A planner reads the classification and builds a per-PR graph of passes from the catalog and the playbooks | Steps 2–3 explicit; passes are domain playbooks, not personas | One planner call, then only the passes that apply | Good if passes share a context block | A bad plan skips a needed pass | Yes, with a pluggable strategy |
| **C** | One senior-reviewer agent with tools, in a loop | All seven steps, in one context | Long loop; risk against the 210s budget | Weak: the context grows each step | One model's blind spots; hard to bound | Yes, but runs vary more |
| **D** | Triage, then specialist investigators with tools, then a verifier, then a writer | Steps 1–7 split by role | More calls than A; the verifier adds one call per candidate or batch | Good for the shared block; tool turns aren't cached | Coordination, cost | Yes |
| **E** | Hybrids, for example B's planner, a deterministic context pre-pass, domain passes, D's verifier | Steps 1–7, with the deterministic parts in code | Between A and D | Good | More moving parts | Yes |

Notes on each:

- **A** keeps what works today: failure isolation per agent, the shared cached prefix, anchor
  validation, the ledger. Those stay in every candidate.
- **B** replaces personas with the guide's playbooks as the unit of work. A move-only PR gets
  the relocation checks and nothing else; an endpoint plus migration gets two playbook passes.
- **C** is closest to how a person reviews, and the hardest to make reliable and fast.
- **D**'s verifier is the cheapest single change against the precision evidence. The discard
  records already reserve `DISCARDED_BY_VERIFY` for it.
- **E** is likely where the experiments end up, but which parts earn their place is the
  question.

## 6. Experiment plan

The replay harness (`ai-review replay`, [the replay design](../superpowers/specs/2026-10-27-review-replay-harness-design.md))
already records real PR rounds, labels them, and re-runs a review against them with a cost cap
(`--live --max-cost`). It measures false positives, recycling, convergence and a join rate
against labelled claims.

### What the harness needs first

1. **A pluggable review strategy.** `--live` re-runs today's pipeline. Each candidate has to
   run through the same interface so the metrics compare like with like.
2. **A checkout per fixture.** Candidates with tools need the repository at the fixture's
   base and head commits, not just the recorded diff.
3. **A join rate that means something.** The out-of-sample 0 of 15 has to be explained (miss
   versus matcher) before recall numbers count.
4. **Seeded fixtures from the catalog.** Joe asked for simulations. Each operation entry's
   "Eval seed" becomes a small synthetic PR with a known right answer:
   - REL-01 move with one stale mock path
   - REL-10 move with one changed comparison
   - DEL guard removal (the guide's `charge()` example)
   - REL-03 rename that changes a serialized field
   - MEC formatter-only change with one hidden logic edit

   These measure recall on the cases that matter, which real fixtures rarely contain.

### Metrics

- **Precision**: share of posted findings that are right, against labels.
- **Recall**: share of labelled real issues found (real fixtures), and seeded right answers
  found (synthetic fixtures).
- **Noise on old code**: findings on lines that only moved, were renamed or were reformatted.
  Should be zero.
- **Recycling and convergence**: repeats across rounds; rounds until nothing real is left.
- **Cost and latency**: per PR, against the hosted budget.

### Order of experiments

Change one thing at a time, cheapest first, so each result says which component matters:

1. **A + verifier.** Same agents, one verification step before posting.
2. **A + context pre-pass.** Same agents, with the operation recipes' results in the shared
   prompt block.
3. **A + both.**
4. **B**: planner and playbook passes, with the winners of 1–3.
5. **C** as a ceiling: one agent with every tool, run locally, no time limit.

Run locally first, where time isn't capped. Move a candidate to the hosted path only once it
wins locally and fits the budget.

### When a result counts

Write the metrics and the threshold down before running. A result counts only on fixtures the
strategy wasn't tuned on (the harness already marks held-out fixtures), on both providers, with
enough labelled claims that one fixture can't decide it. The current held-out set is two
fixtures, which isn't enough; growing it comes first.

## 7. Recommendation, provisional

Start with experiments 1 and 2. The evidence points at missing verification and missing
context more than at the shape of the agent graph, and both can be added to today's pipeline
without replacing it. If they move precision and noise-on-old-code the way the evidence
suggests, the architecture question (B, D or E) becomes a question about which passes to run,
which the catalog already answers.

## Open questions

- Should the verifier be a different model from the finder, the way cross-provider review
  works today?
- Is a design-first round ([triage.md](triage.md)) worth a second review round on large PRs,
  or should design findings simply sort first?
- Where does the planner's knowledge live: in code that reads the catalog, or in a prompt that
  contains it?
- What does the bot do with a PR that has no stated intent: ask and stop, or ask and review?

Running the experiments is follow-up work under its own spec, bead ai-review-bot-t0c.46.
