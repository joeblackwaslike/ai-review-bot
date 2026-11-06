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
| Tier 2 detection | `detectTier2Skills()` in `src/tier2.ts` | Which of four extra personas run | Paths, patch keywords, PR title and body, labels | Same as packing |
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
| Let CI go first | CI results aren't given to the agents (head-SHA check runs only feed the approval message's outstanding-checks note) | Agents comment on things the type checker or tests already caught, or miss that tests fail |
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
| **A0** | Baseline: one diff-only reviewer, same model and token budget as A, run several times | Step 5 once | Set to match A's spend for a fair comparison | Good | Shows whether personas beat buying more inference | Yes, with a pluggable strategy |
| **A** | Today: tiered personas in parallel on one input, then merge | Step 5 only, five times | Known: about 75s for a 14-file diff at concurrency 4 | Good: shared prefix | Overlap, unchecked claims | Yes, today |
| **B** | A planner reads the classification and builds a per-PR graph of passes from the catalog and the playbooks | Steps 2–3 explicit; passes are domain playbooks, not personas | One planner call, then only the passes that apply | Good if passes share a context block | A bad plan skips a needed pass | Yes, with a pluggable strategy |
| **C** | One senior-reviewer agent with tools, in a loop | All seven steps, in one context | Long loop; risk against the 210s budget | To be measured: depends on how each provider caches a growing conversation | One model's blind spots; hard to bound | Yes, but runs vary more |
| **D** | Triage, then specialist investigators with tools, then a verifier, then a writer | Steps 1–7 split by role | Depends on how many investigators run; the verifier adds a call per candidate or per batch | To be measured per provider | Coordination, cost | Yes |
| **E** | Hybrids, for example B's planner, a deterministic context pre-pass, domain passes, D's verifier | Steps 1–7, with the deterministic parts in code | Between A and D | Good for the shared block | More moving parts | Yes |

The cost and cache columns are expectations, not measurements. Each run records cached input
tokens, uncached input, output and reasoning tokens, tool-call costs and wall time, under
matched cold-cache and warm-cache conditions, and the comparison uses those numbers.

Notes on each:

- **A0** answers the first question: does splitting the work into personas help at all, or
  does A only spend more? A tool-using candidate changes too many variables at once to answer
  it.
- **A** keeps what works today: failure isolation per agent, the shared cached prefix, anchor
  validation, the ledger. Those stay in every candidate.
- **B** replaces personas with the guide's playbooks as the unit of work. A move-only PR gets
  the relocation checks and nothing else; an endpoint plus migration gets two playbook passes.
- **C** is closest to how a person reviews, and the hardest to make reliable and fast.
- **D**'s verifier targets the precision evidence directly. The discard records already
  reserve `DISCARDED_BY_VERIFY` for it. Its cost depends on candidate counts and how deep each
  check goes, so it is measured, not assumed cheap. A verifier returns one of three outcomes:
  verified, refuted, or unresolved. Missing evidence or a timeout is unresolved, never
  refuted; an unresolved finding becomes a question, as the guide asks.
- **E** is likely where the experiments end up, but which parts earn their place is the
  question.

## 5a. Direction set by Joe: one reviewer, runbooks and tools

Joe went through today's nine skills and concluded that none of them needs to be a subagent
that reads the whole diff (2026-11-04). The direction is candidate **F**:

- **One main reviewer agent** runs the review. The guide's playbooks and the
  [operations](operations/) entries are its runbooks, and it picks them from the triage in
  [triage.md](triage.md).
- **Today's skills become runbooks or tools.**

  | Today | Becomes |
  | --- | --- |
  | `code-reviewer` | The main reviewer itself |
  | `code-review-and-quality` (five-axis checklist) | A runbook: the guide's review order and checklist already cover correctness, readability, design, security and performance |
  | `pr-test-analyzer` | A runbook (the guide's tests playbooks) plus a coverage tool |
  | `silent-failure-hunter` | A scanner tool that reports line and column, plus a runbook to triage its output |
  | `security-sast` | A scanner tool (SAST and secrets), plus a runbook to triage its output |
  | `type-design-analyzer`, `comment-analyzer`, `security-auditor`, `architect-review` | Runbooks the main reviewer applies when triage finds type, documentation, security-relevant or boundary changes |

- **No subagent runs by default.** If the main reviewer decides a runbook deserves its own
  pass, it creates a subagent and gives it a job, curated context and tools. The context is
  only the files and hunks the job concerns, with whatever surrounding code it needs. A
  type-design pass gets the type changes, not the Dockerfile and the docs. An authentication
  pass gets the session and cookie code. Each subagent's instructions say what changed and
  what to check.
- **Detection is done by the model and the catalog, not by substrings.** The current Tier 2
  detectors match path fragments: `ci` matches `decimal.ts`, `precision.py` and
  `decision.md`, and `user` matches every path under `users/` (bead ai-review-bot-t0c.43),
  so the security auditor runs on PRs with no security content.

Three rules shape F:

- **Deterministic checks bound the model's output.** A language model's output varies from
  run to run. What keeps a review trustworthy is checking it against things that don't vary:
  rules and regexes, linters, type checks, tests, static analysis, security scanners,
  reference lookups. Every finding should be backed or checked by one of these where one
  exists, and each scanner finding is evidence the reviewer confirms, not a comment it posts.
  Today's pipeline has one such check: anchor validation drops comments whose line isn't in
  the diff. The verifier in section 5, which would confirm each finding before it posts, is
  still a proposal; `DISCARDED_BY_VERIFY` is reserved for it and nothing emits it yet.
- **Scanners plus a checklist, never scanners alone.** Each scanner finds only certain
  classes of problem. For security, the main reviewer triages scanner output and also works
  through a checklist end to end for the flow the PR touches. For web applications that
  checklist is the [OWASP Application Security Verification Standard](https://owasp.org/www-project-application-security-verification-standard/)
  (ASVS): its authentication, session management and access control requirements are the
  audit of a registration or login flow, and the
  [OWASP Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
  maps requirements to tests and tools. The guide's
  [authentication and authorization](../Code-Review-Guide-and-Playbooks.md#authentication-and-authorization)
  playbook is the starting runbook; ASVS gives it coverage.
- **Large PRs are split before they are reviewed.** If the diff doesn't fit comfortably in one
  context window, the first step is to split it into chunks that do, along the seams
  triage already finds: operations and domains, so a move-only chunk, a migration chunk and an
  endpoint chunk each get reviewed on their own, followed by one pass that combines them.
  Today's `packDiff()` instead fits the diff into a single prompt: it orders files by
  language and size, drops deletion-only hunks when over budget, cuts the first file that only
  partly fits and marks it truncated, and names every later file in a "Files not shown" line.
  That is close to the strategy of Qodo's PR-Agent, which also makes a single
  model call per tool ([compression strategy](https://docs.pr-agent.ai/core-abilities/compression_strategy/)).
  PR-Agent's [dynamic context](https://docs.pr-agent.ai/core-abilities/dynamic_context/) is
  worth adopting: it widens each hunk to its enclosing function or class, with more lines
  before the change than after.

Where F sits against the candidates in section 5: it is C (one agent with tools) plus the
targeted subagents of D and E, created on demand by the main reviewer.

What has to be measured before F replaces A, all of it in the experiments below:

- **Cost.** Today's five agents share one cached copy of the diff, so input isn't five times
  the cost. The waste is overlapping output (34% restatements) and duplicated reasoning. F
  should cost less, but by how much is what A0 measures.
- **Attention on large PRs.** One agent spread across every concern may miss what a focused
  pass catches. The targeted subagents are the answer to test.
- **Time.** A long tool loop has to finish inside the 210-second hosted budget, or run on the
  local CLI.
- **Running PR code.** The coverage tool needs the tests to run. For an untrusted PR, read
  coverage from CI artifacts or run in an isolated sandbox. The guide's
  [Review locally](../Code-Review-Guide-and-Playbooks.md#review-locally-not-only-in-the-browser)
  section draws the same line.

The scanner tools are specified in [reviewer-tools.md](reviewer-tools.md#tier-4-scanners).

## 6. Experiment plan

The replay harness (`ai-review replay`, [the replay design](../superpowers/specs/2026-10-27-review-replay-harness-design.md))
already records real PR rounds, labels them, and re-runs a review against them with a cost cap
(`--live --max-cost`). It measures false positives, recycling, convergence and a join rate
against labelled claims.

### What the harness needs first

1. **A pluggable review strategy.** `--live` re-runs today's pipeline. Each candidate has to
   run through the same interface so the metrics compare like with like. The interface now
   exists in `src/replay/strategy.ts`, and today's pipeline is registered as `a`.
2. **A checkout per fixture.** Candidates with tools need the repository at the fixture's
   base and head commits, not just the recorded diff.
3. **Frozen inputs.** Models, prompts, budgets and the review history a round may see are
   pinned per run. A round never sees replies, fixes or reviews from after its own time.
4. **A join rate that means something.** The out-of-sample 0 of 15 has to be explained (miss
   versus matcher) before recall numbers count.
5. **Adjudication of unmatched findings.** Historical labels are incomplete: a correct
   finding the old reviewers never made matches no label and would count as a false positive.
   Every unmatched candidate is judged by a reviewer who doesn't know which strategy produced
   it (a different model, then a cross-check), and fixtures are audited for defects the old
   reviewers missed. Without this, precision and recall reward reproducing the old bot.
6. **Seeded fixtures from the catalog.** Joe asked for simulations. Each operation entry's
   "Eval seed" becomes a small synthetic PR with a known right answer:
   - REL-01 move with one stale mock path
   - REL-10 move with one changed comparison
   - DEL-04 guard removal (the guide's `charge()` example)
   - REL-03 rename that changes a serialized field
   - MEC-01 formatter-only change with one hidden logic edit

   Each seed gets independently written variants (other languages, other names, the defect in
   a different place) and a clean control with no defect, so a strategy can't pass by pattern
   matching one example or by flagging everything.

### Metrics

- **Precision**: share of posted findings that are right, against labels plus adjudication.
- **Recall**: share of labelled and adjudicated real issues found (real fixtures), and seeded
  right answers found (synthetic fixtures).
- **Wrong or irrelevant findings**: findings that are incorrect or have nothing to do with the
  change, with a separate count for those on lines that only moved, were renamed or were
  reformatted. The second count is not required to be zero, because a move can create a real
  integration defect; it is required to be about the move, not the moved body.
- **Recycling and convergence**: repeats across rounds and rounds until nothing real is left,
  always reported next to recall and the incomplete-review rate. A strategy that converges by
  saying less is not converging.
- **Cost and latency**: per PR, from the recorded token and time breakdown, and the share of
  runs that would finish inside the hosted budget.

### Design and order

Run A0, A, A + verifier, A + context pre-pass and A + both as a **paired factorial**: every
variant on the same fixture snapshots, several repeated trials each, in randomized order. That
shows each component's effect and their interaction, which a one-at-a-time sequence can't.
Then:

1. **F**, the one-reviewer design from section 5a: first the main reviewer alone with its
   runbooks and tools, then with the targeted subagents it may create. It is compared on the
   same snapshots against A and A0, and against the factorial's best A variant.
2. **B**, planner and playbook passes, only if F loses on large PRs, where a fixed plan of
   passes may beat one agent's choices.

Measure hosted-budget completion from the first run, not only at the end, so a winner that
can't finish in 210 seconds is known early. Run locally first; move a candidate to the hosted
path once it wins locally and the completion rate fits.

### When a result counts

Write the metrics and thresholds down before running. Split fixtures three ways: tuning,
validation, and a test set nobody looks at until the end. A result counts only on the test
set, on both providers, and with uncertainty computed over independent PRs rather than over
claims, since claims within one PR are correlated. A precision gain counts only if recall
holds. The current held-out set is two fixtures, which isn't enough; growing it comes first.

## 7. Recommendation, provisional

Run the factorial in section 6 first. The evidence in section 3 suggests missing verification
and missing context, but it doesn't prove either: duplicate rates show overlap, not its cause,
and the precision figures come from three PRs, which can't separate missing context from model
or prompt effects. The factorial, with the A0 baseline, is the cheapest way to find out which
of those actually matters.

F, from section 5a, is the leading candidate. The factorial still runs first, because it sets
the baselines F has to beat and tells whether verification and context, which F builds in,
are worth their cost.

## Open questions

- Should the verifier be a different model from the finder, the way cross-provider review
  works today?
- Is a design-first round ([triage.md](triage.md)) worth a second review round on large PRs,
  or should design findings simply sort first?
- Where does the planner's knowledge live: in code that reads the catalog, or in a prompt that
  contains it?
- What does the bot do with a PR that has no stated intent: ask and stop, or ask and review?

Running the experiments is follow-up work under its own spec, bead ai-review-bot-t0c.46.
