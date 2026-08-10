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
(upfront Q&A, decide-and-ticket on forks, end-of-run summary + recording an example)
stays constant regardless of scope.

**Revision note (2026-08-10, round 1):** Joe reviewed the first draft and left four
rounds of inline comments, incorporated below: (1) the decision-log mechanism needed
to be explained precisely rather than assumed-understood, plus a trigger to close the
loop — a new `/autonomous:review` command; (2) the example log should be a directory
of dated files with an index, not one growing file; (3) more real examples were
wanted now, plus a mandatory rule that every autonomous run records one (where it
adds new value); (4) skill changes are load-bearing behavior, not docs, and need a
real testing discipline. Each is addressed in its own section below with research
behind it, not just restated.

**Revision note (2026-08-10, round 2):** Second review round, three more points: (1)
whether the Decision Log instruction is global or project-scoped, whether this skill
should own/dictate the whole system (hierarchy, maintenance, mining, applying it to
real decisions, milestones) rather than just reference it, and whether the current
architecture has actually been evaluated against alternatives for simplicity,
effectiveness, and agent compliance — see "Ownership, hierarchy, and architecture
evaluation" below; (3) the example log had the wrong ai-review-bot session — corrected
using the real source Joe pointed at; (4) root-caused why
`superpowers:writing-skills` didn't get invoked during brainstorming (a structural gap
in `superpowers:brainstorming`'s own checklist, not a one-off miss) and fixed it —
`agent-harness/dist/claude-extras.md` now cross-references it, committed and pushed
separately from this spec (commit `9093892`).

## Approaches considered

- **Standalone skill + thin command(s)** (chosen) — mirrors the existing
  `driving-a-pr-to-approval.md` ↔ `/pr-loop` split, and (for the review loop)
  `lessons:review`'s one-at-a-time interactive pattern. A skill holds the contract
  and a growing example log; commands in `agent-harness` trigger the two distinct
  operations (run a task, review judgment tickets). Consistent with established repo
  conventions and requires no new machinery.
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
- `agent-skills/skills/autonomous-agent-operations/references/examples/` — one
  dated file per worked scenario, plus `index.md` — see "Example log" below.
- `agent-harness/commands/autonomous/start.md` — thin command shim, invoked as
  `/autonomous:start`.
- `agent-harness/commands/autonomous/review.md` — the ticket-review loop, invoked
  as `/autonomous:review`.

Both commands live under `commands/autonomous/` from the start now that there are
two of them — Claude Code's subdirectory namespacing gives them the shared
`autonomous:` prefix directly, which is exactly what was deferred as unnecessary
for a single command in the first draft and is now needed.

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
     immediately file a ticket (see "Ticket mechanics" below) capturing the
     question, the decision made, and the rationale, and continue. This is the same
     fork logic already documented for PR review autonomy in `AGENTS.md` ("Stop and
     hand off ... only for: a genuinely hard-to-reverse action ... a real
     product/design decision ...") — reused here rather than redefined, since it's
     the same judgment, **including its hard-stop carve-out**: a genuinely
     destructive, hard-to-reverse action (force-push over a colleague's shared
     branch, a production data change, a permanent deletion) is a stop-and-escalate,
     not a decide-and-ticket. A ticket records a bounded, reversible judgment call —
     it does not undo overwritten commits or deleted data, so it is never a
     substitute for the stop. Take a reversible alternative when one exists (a new
     branch instead of overwriting the shared one); where none exists, stop and
     wait.
   - **End of run.** One closing summary — what shipped, and every judgment ticket
     filed this run, pulled directly from `bd` rather than hand-tracked — **and**
     one new dated file appended to the example log (see "Example log" below). The
     example-log entry is not optional or occasional; it is part of what "done"
     means for a run under this contract.

3. **Ticket mechanics and closing the loop.**

   **What "the decision log" actually is, precisely** (this was underspecified in
   the first draft): `AGENTS.md`'s Decision Log is a **per-project memory file**,
   not a database or an automated pipeline. It lives at
   `~/.claude/projects/<project-path>/memory/feedback_decision-log.md`, one file
   per project, appended to over time, with a one-line pointer added to that same
   directory's `MEMORY.md` index. `ai-review-bot`'s currently holds 11 dated
   entries (oldest 2026-07-31, newest today), each shaped as: a bolded one-line
   rule, the date, which options were offered and which was picked, and a short
   interpretive gloss of the tradeoff — closing with an "Inferred pattern" section
   synthesizing what the entries have in common. `[[wikilinks]]` cross-reference
   related memory files.

   **The on-disk naming (`feedback_decision-log.md`) is the auto-memory system's
   own convention, unrelated to any repo's code style.** The auto-memory system
   (documented in this session's system prompt, not a file in either repo) names
   every memory file `{type}_{slug}.md`, where `type` is one of `user` / `feedback`
   / `project` / `reference` and `slug` is a kebab-case name — confirmed by
   listing `ai-review-bot`'s memory directory: `feedback_decision-log.md`,
   `feedback_confused-emoji-signal.md`, `reference_qstash-region-us-east.md`, etc.
   all follow this exact pattern, and each file's own `name:` frontmatter field is
   the filename itself, not a bare slug. This has nothing to do with `ai-review-bot`
   TypeScript's kebab-case-only convention — it is a different, global system with
   its own naming rule.

   **There is no automated pipeline from `AskUserQuestion` to the decision log —
   it is agent-driven, not hook-driven.** Checked `~/.claude/settings.json` for any
   hook scoped to `AskUserQuestion` or the memory directory: none exists (the only
   memory-adjacent hook is the unrelated Pieces OS `Stop` hook, a different
   long-term-memory system entirely). The mechanism is that `AGENTS.md`'s Decision
   Log section is a **standing instruction the agent follows itself**: "Whenever
   you ask me to choose between options and I answer, record it ... log the date,
   the options you offered, which I picked, and the shape of the tradeoff." The
   agent reads that instruction and, after every `AskUserQuestion` resolution,
   performs the Edit/Write itself — there is no technical enforcement, only the
   documented convention (which this session followed multiple times as its own
   evidence: seven new entries were added to `feedback_decision-log.md` today).

   **Ticket filing.** On a solo mid-run fork, `bd create --labels
   autonomous-judgment ...` with the question, the decision, and the rationale in
   the description — the same three fields a decision-log entry needs, so
   promotion later is a copy, not a rewrite. That text can contain quotes,
   `` ` ``, `$()`, or newlines from the task or repository content, so the
   description is built in a shell-safe variable rather than interpolated
   directly into the command line — the same rule applied to `bd close --reason`
   in the "Apply immediately" row below.

   **Closing the loop — `/autonomous:review`.** A new command, modeled directly on
   the existing `/lessons:review` command (`lessons-learned/commands/review.md`),
   which already solves "work through a queue of items one at a time, propose an
   assessment, ask one decision question, apply immediately, summarize at the end"
   for lesson candidates. The same shape applies here almost mechanically:

   | `/lessons:review` phase | `/autonomous:review` equivalent |
   | --- | --- |
   | Scan + aggregate candidates from the DB | `bd list --label autonomous-judgment --status open` — intentionally *not* run-scoped: a review pass works through the whole open backlog across every run, not one run's tickets (contrast with the end-of-run report below, which is run-scoped). (Note: `bd list` takes `--label`, singular; `bd create` takes `--labels`, plural — verified against `bd <cmd> --help`, not interchangeable) |
   | Pre-filter silently (dupes, hallucinated) | Skip tickets already closed/promoted |
   | Prepare suggested edits per candidate | Prepare an assessment: does this decision still look right given anything learned since, is there a closer-matching existing decision-log entry, what would you recommend |
   | Display candidate + "My take" | Display the ticket's question/decision/rationale + the assessment |
   | Ask one `AskUserQuestion` (promote / archive / modify / skip) | `AskUserQuestion` allows 2–4 options, never 5 — a hard tool constraint. Ask a 4-option coarse question first: **Confirm as logged** / **Change it** / **Skip** / **Promote to global**; if "Change it," ask a *second*, separate `AskUserQuestion` (2 options: **I'll state the answer** / **Give me 2-3 framings**) — sequential calls are fine, only the options within one call are capped |
   | Apply immediately, one-line status, next candidate | Append the (confirmed or corrected) entry to `feedback_decision-log.md`, **citing the ticket ID** (so a retried promotion detects the existing entry and skips re-appending rather than duplicating), update `MEMORY.md`'s pointer if this is that project's first entry, then `bd close` the ticket with a shell-safe (variable-built, not directly-interpolated) reason string — same for the `Promote to global` path once the `AGENTS.md` edit is presented and approved, so a promoted ticket actually leaves the open queue rather than re-presenting on every future run |
   | Session summary (promoted/archived/skipped/total) | Session summary (confirmed/corrected/skipped/promoted-to-global counts, decision-log entries added) |

   This gives every `autonomous-judgment` ticket an actual review path, closing the
   loop Joe asked for rather than leaving tickets to accumulate unreviewed.

   **"Every ticket filed this run" needs a real scope.** A bare label match pulls
   every open ticket ever filed under it, including earlier or concurrent runs, not
   this run's specifically. `/autonomous:start` generates a run ID and tags every
   ticket it files with it as a second label; the end-of-run pull is `bd list --label
   autonomous-judgment,run-<id>` (AND semantics — confirmed directly against `bd list
   --help`: "`-l, --label strings` Filter by labels (AND: must have ALL)", not just
   assumed from the `--label`/`--labels` naming split), not the bare label. The query
   carries no `--status` filter, so it returns the run's tickets regardless of
   whether they're still open or were closed during the run.

4. **Future direction, explicitly not in scope now.** Joe raised aggregating
   decision-log data across projects into something that actively drives better
   autonomy over time — possibly an "executive decision-maker" agent that
   unblocks implementer agents, possibly notified through a chat channel (mechanism
   still undecided). The one firm requirement stated: **this data must not just
   accumulate — some system has to act on it to improve decisions, or collecting it
   has no point.** Deliberately deferred rather than designed here, per Joe's own
   "keep it simple in the beginning and add complexity later" — filed as
   `ai-review-bot-l91` so the requirement isn't lost, not
   designed inline in a spec that's already about the simpler, prerequisite piece
   (getting judgment calls logged and reviewed at all). The existing "Inferred
   pattern" section already in `feedback_decision-log.md` is the closest thing to
   this that exists today — a manually-written synthesis, not an automated one —
   and is the natural seed for whatever this becomes.

5. **Pointer to `references/examples/`** for worked scenarios — see next section.

### Ownership, hierarchy, and architecture evaluation

Joe asked, on review of the first draft, whether the Decision Log instruction is
global or project-scoped, whether this skill should own and dictate the whole
system rather than just reference it (runbooks, maintenance, mining, the
user/project hierarchy, applying the corpus to actual autonomy decisions, future
milestones), and whether the current architecture (memory files + `MEMORY.md`
index + beads/labels) has actually been evaluated against alternatives for
simplicity, effectiveness, and — specifically — **agent compliance**. Answered in
order, with research behind each:

**Scope: global, not per-project.** `AGENTS.md`'s Decision Log section lives in
`~/.claude/AGENTS.md`, which is a symlink to `agent-harness/AGENTS.md` — the
single global instructions file every project's `CLAUDE.md` imports via `@AGENTS.md`
(confirmed directly: this is the exact file this session edited for the
"Proactivity" backlog item, via its real symlink target). The section's own text
already says so ("This applies to every project, not just the one where a given
decision came up"). It is not duplicated per project; only the *log files it
produces* are project-scoped.

**Ownership: yes, the skill should be authoritative, not `AGENTS.md`.** This
matches a pattern already established in this exact codebase: `AGENTS.md`'s "PR &
Merge Autonomy" section is three paragraphs of policy that explicitly defers all
mechanics to `driving-a-pr-to-approval.md` ("Load the working-with-github skill
before acting on any PR ... it holds the facts this section deliberately does not
restate"). The Decision Log section should get the same treatment: trimmed from
its current ~15 lines of full mechanics to a short pointer once
`autonomous-agent-operations`'s `SKILL.md` exists, e.g.:

> ## Decision Log (log every judgment call I answer)
>
> Mechanics, format, hierarchy, and maintenance now live in the
> `autonomous-agent-operations` skill (`agent-skills`) — load it before recording
> or reviewing a judgment call. This section is the policy statement, not the
> mechanics: every `AskUserQuestion` I answer and every reviewed
> `autonomous-judgment` ticket gets logged; the point is autonomy — decide the
> next similar call my way instead of re-asking.

This is a real implementation task for the plan (edit `agent-harness/AGENTS.md`
alongside creating the skill), not done in this pass — the current spec-writing
session already made one unrelated, already-approved edit to that exact file today
(the Proactivity addendum) and stacking an unreviewed second edit on top mid-spec
risks conflating two changes; it belongs in the implementation plan's task list
where it can be reviewed as one unit with the skill it depends on.

**Hierarchy: three tiers, made explicit** (today this exists only as one gestural
sentence — "if a decision is clearly cross-project ... say so ... it can be
promoted here later" — with no actual promotion mechanism):

1. **Project decision log** (`feedback_decision-log.md`) — the working tier,
   high-volume, specific.
2. **Cross-project candidates** — an entry in tier 1 flagged, at write time, as
   likely applying beyond this project (already partially done today, e.g. this
   session's own "Cross-project pattern, not `ai-review-bot` specific" note on the
   worktree-isolation decision).
3. **Global standing rules** (`AGENTS.md` itself) — rare, hand-authored, reserved
   for patterns confirmed across enough tier-2 candidates to be worth a permanent
   rule, not a log entry.

The missing piece is a *mechanism* for tier 1 → tier 2 → tier 3, not just the
concept. `/autonomous:review`'s decision options (Confirm / Change it / Skip) get a
fourth: **Promote to global** — when a reviewed entry is confirmed as cross-project,
this drafts the `AGENTS.md` addition as a proposed edit for Joe's approval (following
`AGENTS.md`'s own RED-GREEN discipline for editing itself), closing the ticket on
approval the same as any other promotion, rather than silently accumulating tier-2
flags nobody acts on or re-presenting an already-promoted ticket forever.

**Maintenance, mining, and milestones — staged, not built all at once now**
(matching Joe's own "keep it simple, add complexity later" pattern already applied
to the executive-decision-maker idea, extended here to the same class of ask):

- **Phase 1 (this spec):** ticket → `/autonomous:review` → promote to project log
  or global rule. This is the prerequisite everything else depends on — there is
  no corpus to mine or maintain until judgment calls are actually being logged
  and reviewed consistently.
- **Phase 2 (near-term follow-up, not this spec):** a `lessons:doctor`-style audit
  — mirroring that command's role for the lessons DB (dead entries, near-duplicates,
  misclassified types) — applied to decision logs: stale entries whose precedent no
  longer holds, near-duplicate rules that should merge, entries that were never
  actually applied to a matching later call (a compliance signal in its own right).
  Natural home: fold into `/autonomous:review`'s own closing phase, the same way
  `lessons:review`'s Phase 5 auto-runs `/lessons:doctor`.
- **Phase 3 (`ai-review-bot-l91`, already filed):** mining across projects into
  something that actively drives decisions — the "executive decision-maker" idea.
  Phase 1 and 2 are load-bearing prerequisites for this, not parallel work — an
  executive-decision system trained on inconsistently-logged, unaudited data
  would be worse than none.

**Architecture evaluation — was this analyzed against alternatives, and is there
room for improvement?** Yes, done here rather than assumed. Three shapes
considered for where a judgment call's data actually lives:

| Option | Pro | Con |
| --- | --- | --- |
| **A — everything in beads** (single system) | Unified; queryable; labels/priority/status for free; already Dolt-backed and cross-machine synced | Not auto-loaded into a session's context the way memory files are — the auto-memory system's entire value is that it's read automatically at session start; moving decisions into beads-only would need a *new* context-injection mechanism to replace that, which is more complexity, not less |
| **B — everything in markdown memory** (no beads staging) | Simplest; one system; already auto-loaded | No structure for the review queue itself — no labels/status to drive `/autonomous:review`'s "what's pending" query, no way to distinguish reviewed from unreviewed entries in a flat prose file |
| **C — current design: beads for staging, markdown for the curated/auto-loaded record** | Queryable intake (`bd list --label autonomous-judgment`) feeding a curated, auto-loaded output; each system does the one job it's actually good at | Two systems instead of one — real complexity cost, justified below |

**C is the right choice, and it's not a novel design** — it's the same two-tier
shape `lessons-learned` already uses and has been running in production: a
queryable DB of *candidates* (`lessons.mjs list`, filterable, reviewed one at a
time via `/lessons:review`) promoted into a curated *manifest* that gets
auto-injected at session start and periodically reinforced. Decision-log tickets
→ project decision-log entries is the identical shape applied to judgment calls
instead of behavioral lessons — strong existing precedent, not an unproven bet.

**The real, correctly-identified gap is compliance, not architecture.** The
decision-log write itself — after a live `AskUserQuestion`, today, with no
`autonomous-judgment` ticket involved — has **no technical enforcement at all**:
confirmed by checking `~/.claude/settings.json` for any hook scoped to
`AskUserQuestion` or the memory directory (none exists). It is purely "the agent
reads `AGENTS.md`'s instruction and remembers to do it," which is exactly the
kind of instruction that degrades under long-context pressure — the same
degradation problem `lessons-learned`'s own `posttooluse-directive-reinject.mjs`
hook exists to solve for *its* directives (re-injecting standing instructions at
30/52/70% context-usage thresholds, because "directives and protocols injected at
session start lose Claude's attention as context fills").

**Concrete, low-cost fix, not a new hook:** `lessons-learned` is already installed
and already runs this reinjection machinery. Registering the decision-log
obligation as a `directive`-type entry in its manifest (`type: "directive"`,
`priority: 10`, no tool/path trigger needed — it's a standing reminder, not a
guard) gets it the same periodic reinforcement every other standing directive in
this environment already gets, for the cost of one manifest entry — no new hook
code. This is a real recommendation, not decided here: **flagging for your call
on the next review round** whether it belongs in this implementation's initial
scope or as a fast-follow, since it's cheap enough that "add it now" and "add it
after Phase 1 ships" are both reasonable.

### Example log

**Restructured to a directory, not one file** (Joe's suggestion, adopted — it
matches this repo's own `docs/superpowers/specs/YYYY-MM-DD-<topic>.md` convention,
which is a good precedent for a log meant to accumulate substantial, individually
addressable entries rather than grow as one file):

- `references/examples/index.md` — one line per entry: date, project, one-sentence
  scenario, link.
- `references/examples/YYYY-MM-DD-<project>-<slug>.md` — one file per scenario, in
  the same `Scenario / What stayed solo / What forked / Why` shape as the original
  draft.

**Populated with real, checked entries, not fabricated ones** — Joe asked for prior
ai-review-bot autonomous/overnight work and similar cc-recall work to be added now.
Both were investigated rather than assumed:

- **`2026-08-09-ai-review-bot-multi-item-plan.md`** — this session (already
  drafted in the first pass, unchanged): a pre-approved multi-item plan executed
  end to end, forking twice via live `AskUserQuestion` (Dashboard infra risk;
  mechanically-silent required reviewer bot) because the user was in fact
  reachable — the contract's "ask when reachable" branch, not "ticket when not."
- **`2026-07-30-ai-review-bot-overnight-feedback-pipeline.md`** — corrected
  entry: the first draft investigated a commit-burst pattern and, finding nothing
  in the repo confirming it ran unattended, left it out. Joe pointed at the real
  source — `agent-marketplace/private-content/drafts/articles/
  2026-08-08-writing-the-plot.md`, a first-person **draft blog post (unpublished,
  not an internal record — cite accordingly, see caveat below)** — which
  describes this exact night directly. An agent built a ~6,500-line, nine-PR
  feedback-capture pipeline in this repo unattended overnight; the merges land
  between 3:41am–8:41am UTC, which converts exactly to the 23:41–04:41 EDT window
  of PRs #32–#42 the first draft had already found by commit timestamp but
  couldn't confirm as unattended — this article is that confirmation. The
  handoff, quoted directly (given as the general template now used, not
  necessarily verbatim that specific night): *"I won't be around. Work
  autonomously and use your best judgement. If you hit a genuine blocker, pick
  the most reasonable option, document the decision and your reasoning, and file
  a beads issue for it. When I'm back, we'll review them one at a time. Hard stop
  on anything involving permanent data loss."* — this is close to a plain-English
  version of the fixed contract this spec formalizes. The fork that actually
  happened: 8 of the 9 PRs merged with a standing `CHANGES_REQUESTED` from the
  required reviewer still attached; the agent read the review bodies, judged the
  reviewer stuck/recycling false positives, and invoked the pre-existing
  dismiss-and-merge override policy (the same one this session invoked twice on
  PR #55/#56) rather than waiting. **Caveat, stated as plainly as the article
  itself states it:** the author's claim to have verified the merged work
  afterward ("I've read the diffs since; the work is good") is self-reported in
  an unpublished marketing/essay draft, not shown with diffs or PR links in the
  source — recorded here as the account given, not as independently confirmed
  fact, consistent with this project's own "no hypothesis without data" standard.
- **`2026-07-29-cc-recall-quota-burn.md`** — a genuine unattended episode, but a
  **cautionary one, not a demonstration of the contract working**: per
  `postmortems/postmortems/001-cc-recall-quota-burn.md`, a `/recall:backfill` run
  spawned ~2,825 headless sessions over ~43 hours, ran unattended 1am–9am with "no
  rate limit, no session-count alarm, no cost ceiling, and no convergence check,"
  and burned an estimated 69% of a weekly quota before anyone noticed. Root cause
  was three compounding defects in `runClaudeHeadless`, fixed in cc-recall PR #54
  and #55 — the same night the overnight feedback-pipeline entry above describes,
  in fact: per the same article, this incident is what the overnight run was
  *cleaning up*, not an unrelated example. Included as the motivating anti-pattern
  for why the fixed contract's fork logic exists at all: unattended operation with
  *no* bounded decision/ticket points and no cost ceiling is exactly the failure
  mode this skill is meant to prevent.

**Mandatory recording, not occasional** (Joe's correction to the first draft, which
only said "add an entry whenever a run demonstrates a materially different
scenario"): folded into the fixed contract's "End of run" bullet above — every run
under this contract appends one dated file and one `index.md` line, full stop. The
"materially different scenario" framing from the first draft is demoted from a
gate on *whether* to record to guidance on *what to emphasize* in the write-up.

### Commands

**`agent-harness/commands/autonomous/start.md`** — mirrors `pr-loop.md`'s shape:

```markdown
---
name: autonomous:start
description: Operate solo on a handed-off task per the autonomous-agent-operations contract — ask up front, decide and ticket on forks, summarize and record at the end
argument-hint: "<task description>"
---

Take on the described task and run it to completion without check-ins beyond the
skill's fixed contract.

**Load the `autonomous-agent-operations` skill before doing anything else.** It is
the single source of truth for this workflow — the upfront-question pass, the
decide-and-ticket fork logic, and the end-of-run summary + example recording. This
file deliberately contains no rules of its own.

## Invocation contract

- **Argument:** a description of the task (or a reference to an existing plan/spec
  to execute).
- **Ask every clarifying question up front**, per the skill, before starting solo
  work.
- **Runs to completion without check-ins** beyond the skill's fork logic.
- **Reports:** what shipped, every `autonomous-judgment` ticket filed, and the new
  example-log entry.
```

**`agent-harness/commands/autonomous/review.md`** — mirrors `lessons:review`'s
phase structure (Scan/Aggregate → one-at-a-time with a prepared assessment and one
`AskUserQuestion` → apply immediately → session summary), adapted per the mapping
table above. Full phase-by-phase text is an implementation detail for the plan, not
this spec — the mapping table already fixes the behavior precisely enough to write
from.

## Testing / verification

**This is not a docs-only change, and treating it as one was the first draft's
mistake** (Joe's correction). Skill files are load-bearing — they change agent
behavior — and this repo's own `~/.claude/AGENTS.md` already says as much generally
("Editing Skills, Runbooks and Instructions" requires RED-GREEN even for prose).
What's specific to *skill* files (as opposed to a runbook edit) is more exacting,
and — checked rather than assumed — **it already exists, this is not a gap to
fill**:

- `superpowers:writing-skills` states the discipline as an Iron Law: *"NO SKILL
  WITHOUT A FAILING TEST FIRST ... This applies to NEW skills AND EDITS to
  existing skills."* Its RED-GREEN-REFACTOR mapping for skills: RED = a pressure
  scenario run against a subagent *without* the skill, demonstrating the bad
  behavior the skill is meant to prevent; GREEN = the same scenario with the skill
  present, agent complies; REFACTOR = close loopholes a variant scenario finds.
- `agent-skills:best-practices-for-agentic-development` (`references/skill-
  development.md`) independently documents the same discipline in more compact
  form: define the target behavior, write a failing pressure scenario, add the
  smallest skill text that changes it, re-test, refactor.
- `skill-creator:skill-creator`'s "eval" mechanism was checked too and is a
  **different thing** — parallel with-skill/without-skill subagent runs graded and
  aggregated into a pass-rate/timing/token-cost benchmark with variance, useful for
  comparing configurations, but it does not require observing a failure *before*
  writing the skill, so it's a benchmark suite, not a red-green gate.

**Verification for this spec's implementation, concretely:** writing
`SKILL.md` and the two commands follows `superpowers:writing-skills`'
RED-GREEN-REFACTOR process — a pressure scenario (e.g. "agent hits a mid-run
ambiguity with no clarifying-question pass available") run against a subagent
*without* the skill loaded first, to confirm the bad behavior (blocks entirely, or
guesses silently with no ticket) actually happens baseline, then again with the
skill loaded to confirm it now asks-up-front / decides-and-tickets / summarizes as
specified. This becomes an explicit task in the implementation plan, not an
afterthought — the plan-writing step (`superpowers:writing-plans`, next after this
spec is approved) is where the concrete pressure scenarios get authored, since
that's where implementation detail belongs, not this spec.
