# Autonomous Agent Operations — skill + command design

## Context

`docs/_backlog.md` has carried an entry since 2026-07-31: a skill "parallel to
`driving-a-pr-to-approval` + `/pr-loop`" for operating autonomously while Joe is away —
ask clarifying questions up front, then work solo; use best judgment on mid-run
ambiguity and file a ticket rather than blocking; summarize everything completed plus
every ticket filed at the end. Two adjacent mechanisms were identified as *not*
covering this: `AGENTS.md`'s Decision Log only logs choices Joe already made when
answering an `AskUserQuestion`, not judgment calls made solo in his absence;
`beadboard-driver` is a supervised-swarm contract (explicit assignee/evidence, a human
watching a live dashboard), not an unattended away-mode with upfront Q&A.

This spec was brainstormed in the same session that drove a large multi-item plan
through `ai-review-bot` end to end — a live example of exactly the gap this skill
fills, and the anchor for its first worked example. Per Joe's explicit steer during
brainstorming: the *autonomy scope* (how much gets done solo before a fork appears)
should be loosely defined and extensible — expected to grow more sophisticated over
time as more infrastructure and precedent accumulate — while a small *fixed contract*
(upfront Q&A, decide-and-ticket on forks, end-of-run summary) stays constant
regardless of scope.

## Approaches considered

- **Standalone skill + thin command** (chosen) — mirrors the existing
  `driving-a-pr-to-approval.md` ↔ `/pr-loop` split exactly: a skill holds the
  contract and a growing example log, a thin command in `agent-harness` triggers it.
  Consistent with established repo conventions and requires no new machinery.
- **Inline in `AGENTS.md`** (rejected) — breaks the existing pattern where
  `AGENTS.md` holds policy pointers and `agent-skills` holds mechanics (see "PR &
  Merge Autonomy", which points at `driving-a-pr-to-approval.md` rather than
  restating it).
- **Extend `beadboard-driver`** (rejected) — already established as covering a
  structurally different scenario (supervised swarm, human watching live) per the
  backlog's own analysis.

## Design

### File layout

- `agent-skills/skills/autonomous-agent-operations/SKILL.md` — the fixed contract
  and the loose-autonomy framing.
- `agent-skills/skills/autonomous-agent-operations/references/examples.md` — a
  living, appendable log of worked scenarios at different autonomy levels.
- `agent-harness/commands/autonomous.md` — thin command shim, invoked as
  `/autonomous`. Single command for now; if related commands are needed later
  (e.g. a ticket-review helper), move this into `agent-harness/commands/autonomous/`
  so Claude Code's subdirectory namespacing gives them a shared `autonomous:` prefix
  — don't build that structure for one command today.

### SKILL.md contents

1. **What this is.** A framework for operating solo on a handed-off task, at
   whatever autonomy level the task and available infrastructure support today.
   Explicitly not capped at one scenario — the loose, growing part is *how much*
   gets done solo before a fork appears, not *whether* the contract below applies.

2. **The fixed contract** (always true, regardless of scope):
   - **Upfront.** Ask every clarifying question needed before starting solo work —
     same discipline as a live `AskUserQuestion` pass, batched up front rather than
     dripped out mid-run.
   - **Mid-run fork.** When something needs a real decision — a hard-to-reverse
     action, a real product/design call, or a factor no existing precedent (memory,
     backlog, prior ticket) covers — and the user might plausibly be reachable, ask
     live. When not, or when waiting would stall the run, use best judgment, then
     immediately `bd create` a ticket capturing the question, the decision made, and
     the rationale, labeled `autonomous-judgment` (`bd create --labels
     autonomous-judgment ...`), and continue. This is the same fork logic already
     documented for PR review autonomy in `AGENTS.md` ("Stop and hand off ... only
     for: a genuinely hard-to-reverse action ... a real product/design decision ...")
     — reused here rather than redefined, since it's the same judgment.
   - **End of run.** One closing summary: what shipped, and every
     `autonomous-judgment` ticket filed this run — pulled directly via `bd list
     --labels autonomous-judgment`, not hand-tracked, so the summary can't drift
     from the actual ticket state.

3. **Closing the loop.** Reviewing an `autonomous-judgment` ticket later (confirming
   or correcting the call) promotes it into that project's `feedback_decision-log`
   memory — the same mechanism a live `AskUserQuestion` answer already feeds, per
   `AGENTS.md`'s Decision Log. One record, not two parallel ones. The memory entry
   cites the ticket ID so the original question/rationale stays traceable.

4. **Pointer to `references/examples.md`** for worked scenarios, with an explicit
   note that the list is meant to grow: add an entry whenever a run demonstrates a
   materially different scenario than what's already documented (e.g. a longer
   unattended stretch, a new class of fork, a new source of precedent to decide
   against) — the existing entries are a starting point, not an exhaustive
   taxonomy.

### references/examples.md

Starts with one entry, format `Scenario / What stayed solo / What forked / Why`:

> **2026-08-09, `ai-review-bot`.** A pre-approved multi-item plan (a root-cause
> writeup, four small backlog items, this skill, a dashboard risk spike) executed
> end to end across two repos, including driving three PRs through multi-round
> review to merge. What stayed solo: all implementation, all review-thread triage
> and replies, two dismiss-and-merge calls on stuck/silent reviewer bots (each
> matching an existing `AGENTS.md`-documented pattern). What forked: whether to
> pause before touching production infrastructure with a silent, wide blast radius
> (the Dashboard's Next.js/webhook-coexistence risk) — paused even though every
> other item in the same plan ran straight through; and how to treat a required
> reviewer bot that was mechanically silent on a fresh commit rather than raising a
> content objection. Why: both were live `AskUserQuestion` calls, not
> decide-and-ticket, because the user was in fact reachable — the fixed contract's
> "ask when reachable" branch, not its "ticket when not" branch. No
> `autonomous-judgment` ticket was filed this run for that reason; the next entry
> in this log should be a run where the ticket path is actually exercised.

### Command (`autonomous.md`)

Mirrors `pr-loop.md`'s shape exactly:

```markdown
---
name: autonomous
description: Operate solo on a handed-off task per the autonomous-agent-operations contract — ask up front, decide and ticket on forks, summarize at the end
argument-hint: "<task description>"
---

Take on the described task and run it to completion without check-ins beyond the
skill's fixed contract.

**Load the `autonomous-agent-operations` skill before doing anything else.** It is
the single source of truth for this workflow — the upfront-question pass, the
decide-and-ticket fork logic, and the end-of-run summary. This file deliberately
contains no rules of its own.

## Invocation contract

- **Argument:** a description of the task (or a reference to an existing plan/spec
  to execute).
- **Ask every clarifying question up front**, per the skill, before starting solo
  work.
- **Runs to completion without check-ins** beyond the skill's fork logic.
- **Reports:** what shipped, and every `autonomous-judgment` ticket filed.
```

## Testing / verification

Docs-only change — no code. Verification is: the spec reads coherently end to end
(this self-review pass); the skill and command land in a follow-up implementation
PR against `agent-skills` and `agent-harness` respectively, each getting the normal
skill/command review (`plugin-dev:skill-development` conventions for the skill,
matching `pr-loop.md`'s existing shape for the command); and the first real
exercise of the decide-and-ticket path becomes `examples.md`'s second entry.
