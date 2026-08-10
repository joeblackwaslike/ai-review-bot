# Post-Mortem: Review Bots Hallucinating Findings (Sentry/Statsig False Premise + Anthropic-Only Tuning)

**Date:** 2026-08-09
**Duration:** ~70 minutes from bisection start to root cause (bead `ai-review-bot-5zu`,
opened 01:16 UTC, closed 02:26 UTC) — the underlying quality problem itself predates
this by roughly six weeks
**Severity:** Both required review bots (`anthropicreviewbot`, `codexreviewbot`)
independently posted confidently false findings across multiple review rounds on live
PRs, several of which recycled after being refuted

---

## What Happened

On PR #44 (2026-08-08/09), `anthropicreviewbot` claimed across **all 6** of its review
rounds that the code "bypasses Sentry via `console.error` instead of the project's
`logError`." `codexreviewbot` independently repeated the same false claim. Neither
Sentry nor Statsig nor any `constants/errorIds.ts` file has ever existed in this repo.
Separately on the same PR, `codexreviewbot` fabricated a compilation-break claim about
`peers.ts` and an invalid-JSON claim about `vercel.json`, both refuted against a green
CI. This happened despite the prior stuck-loop epic (`ai-review-bot-9nv`, closed via
PR1 #21 / PR2 #22) having already shipped a triage gate specifically meant to stop
reviewers from recycling stale findings.

Joe's framing going in: "it used to be fine" — investigate when/why, bisect to a
specific cause, fix it, and audit every previous point-fix (guardrails, claim-dedupe,
reviewer-tuning, carrier-compact, review-state triage gate) to see whether it's still
earning its keep now that a root cause might be known.

## Timeline

| Time | Event |
| --- | --- |
| 2026-06-17 | Tier 2 review skills go default-on (PR #22, `REVIEW_TIER2_ENABLED`), predating the gap below by 10 days. |
| 2026-06-27 → 07-31 | A 34-day gap in PR activity on this repo. |
| ~early Aug | A 19-PR / 30-hour burst, with Tier 2 already active throughout, coincides with an already-fixed 800s Vercel timeout bug (PR #45) that, before the fix, silently dropped agents mid-run with no review posted at all. |
| 2026-08-08/09 | PR #44 review rounds: `anthropicreviewbot` repeats the Sentry/`logError` claim across all 6 rounds; `codexreviewbot` repeats it independently and separately fabricates a compilation-break claim on `peers.ts` and an invalid-JSON claim on `vercel.json`. |
| 2026-08-09 01:16 UTC | Bead `ai-review-bot-5zu` opened: bisect and root-cause the degradation. |
| 2026-08-09 | PR #53 opened, fixing the false Sentry/Statsig/`errorIds.ts` premise in `skills/silent-failure-hunter.md`. |
| 2026-08-09 | PR #54 opened, unifying `reviewer-tuning.ts` across both providers and fixing an independently-discovered FULL-pass carry-forward bug. |
| 2026-08-09 02:26 UTC | Bead `ai-review-bot-5zu` closed with both PRs merged and live-verified. |

## Root Cause

Two compounding, dateable factors — not a single clean regression:

**1. A vendored false premise in `skills/silent-failure-hunter.md`.** Since the
repo's very first commit (`1f247a3`), the skill's "Special Considerations" section
asserted as established fact that this project has a `logError` function wired to
Sentry, a `logEvent` wired to Statsig, and an error-ID scheme in
`constants/errorIds.ts`. None of that exists in `ai-review-bot` — it is boilerplate
vendored from a different project's stack, present in the skill file from day one.
Every review agent using this skill was told, as a project fact, to check code
against an integration that was never built. This is the direct source of the
"bypasses Sentry" hallucination recycled across all 6 `anthropicreviewbot` rounds on
PR #44 and independently repeated by `codexreviewbot`.

**2. Quality was marginal from early development, not a clean "used to be fine, then
broke" story.** There is a real, measured step-change in the PR activity that resumed
after the 2026-06-27 → 07-31 gap — average review rounds per PR roughly doubled.
**Correction to an earlier draft of this doc** (caught by `chatgpt-codex-connector`
review on this doc's own PR): Tier 2 going default-on (PR #22) did not happen at the
gap's end — it merged 2026-06-17, ten days *before* the gap started, and was already
active throughout it. The round-doubling is a real, dated observation about the
post-gap PR burst; Tier 2 being on isn't a new variable introduced at that point, so
it should be read as "already active during the burst that showed the step-change,"
not "the burst's trigger." That burst — 19 PRs in ~30 hours — also coincided with the
(at-the-time-unfixed) 800s Vercel function timeout, which silently dropped agents
mid-run and produced no review at all rather than a degraded one.

## Data / Metrics

From PR #46's corpus replay (the source of the "403/1180 = 34%" restatement stat
quoted in this repo's `CLAUDE.md`):

**Defect-rate table** (real defects vs. total findings, by round):

| PR | Round | Findings | Real defects |
| --- | --- | --- | --- |
| #43 | 1-2 | 72 | 13 |
| #43 | 3-4 | 48 | **0** |
| #43 | 5 | 45 | not triaged — merged |
| #45 | 1-2 | 28 | 6 |
| #45 | 3 | 12 | **0** |

**Dedup replay** — 28 PRs, 1180 anthropic findings, 403 collapsed as near-duplicate
restatements (34.2%):

| PR | Before → after |
| --- | --- |
| #18 | 355 → 96 (259 collapsed) |
| #43 | 97 → 83 |
| #34 | 89 → 76 |
| cc-recall#25 | 58 → 46 |

An 18-pair precision spot-check across the merged set found 18/18 correct — several
were byte-identical titles filed twice.

**Severity-vs-usefulness inversion** (issue #38): high-severity findings were useful
8% of the time, versus 58% for medium-severity findings — severity was tracking
model confidence, not actual impact.

## Fixes Shipped

**[PR #53](https://github.com/joeblackwaslike/ai-review-bot/pull/53)** —
`fix(skills): stop silent-failure-hunter asserting a nonexistent Sentry integration`
(+15/-6, 1 file, 3 commits). Rewrote three sections of
`skills/silent-failure-hunter.md` ("Logging Quality," "Validate Against Project
Standards," "Special Considerations") to ground any logging/error-tracking claim in
the diff or the project's own `CLAUDE.md`/`AGENTS.md`, and to state explicitly that
asserting a nonexistent integration is itself a false finding — rather than asserting
a fixed stack as fact.

**[PR #54](https://github.com/joeblackwaslike/ai-review-bot/pull/54)** —
`fix(review): unify signal-quality tuning across both providers` (+194/-89, 5 files,
3 commits). `reviewer-tuning.ts` had scoped `dedupeNearDuplicateClaims`,
`showPriorOwnFindings`, and `strictEvidenceRules` to anthropic-only since
[PR #46](https://github.com/joeblackwaslike/ai-review-bot/pull/46), on the explicit
premise (stated in that PR's own body) that "codexreviewbot ... duplicated far less
... the corpus has only 12 openai findings, too few to measure against." PR #44's
fresh evidence overturned that premise directly: `codexreviewbot` independently
produced the same class of confidently-false findings anthropic had been fixed for.
PR #54 collapsed the `TUNED`/`LEGACY` split into a single `REVIEWER_TUNING` constant
applied unconditionally to both providers.

The same PR also fixed a real, independently-discovered P1 (found by
`chatgpt-codex-connector`, an advisory bot — not the required `codexreviewbot`,
worth stating plainly since conflating the two is a documented pitfall): the review
pipeline's `showPriorOwnFindings` instruction tells agents on every pass not to
re-file an already-open finding, but only the `INCREMENTAL` triage path fed that back
into `survivingPrior`/persisted state. A `FULL` review pass whose agents correctly
followed the instruction and didn't restate a still-open finding had nothing carrying
it forward — it could silently drop out of tracked state and the review could
false-`APPROVE` past an unresolved issue. This predated PR #54 (already true for
anthropic since #46) but was fixed regardless, since unifying tuning doubled its
exposure. A red-then-green test pins the fix (`review.test.ts`, "buildReview triage
gate — FULL carries forward open prior findings").

## Point-Fix Audit

Per the bead's own acceptance criteria — every prior point-fix aimed at this general
class of problem, evaluated against the newly-identified root cause:

| Point-fix | Verdict | Why |
| --- | --- | --- |
| Epistemic guardrails ([PR #25](https://github.com/joeblackwaslike/ai-review-bot/pull/25)) | **KEEP** | Complementary — targets diff-speculation (claiming things about code not in the diff), not a false premise baked into a skill's own instructions. Different vector from the one #53 fixes. |
| 800s timeout fix ([PR #45](https://github.com/joeblackwaslike/ai-review-bot/pull/45)) | **KEEP** | Already fixed — makes the platform timeout survivable (partial review with a notice) rather than silently dropping every finding. Independent of the hallucination root cause. |
| Claim-dedupe ([PR #46](https://github.com/joeblackwaslike/ai-review-bot/pull/46), `src/claim-dedupe.ts`) | **KEEP** | Validated live at 34% restatement rate on the corpus (above); addresses a different failure mode (one real claim restated across adjacent lines), orthogonal to false premises. |
| Reviewer-tuning anthropic-only scoping (PR #46) | **SUPERSEDED** | By PR #54's unification. The premise it was built on ("codexreviewbot doesn't do this") was correct when written and directly falsified by PR #44's evidence. |

## Live Verification

Watched both PR #53 and PR #54's own review rounds after merge. Neither bot repeated
the Sentry/`logError` hallucination as a *live* claim about current code — both
correctly described it as a historically-fixed issue (`anthropicreviewbot`: "removes
false hardcoded assumptions... that caused hallucinations in prior reviews").

One new false claim did surface during this window: `codexreviewbot` fabricated a
"duplicated stale prompt block still asserts Sentry/Statsig" claim on PR #53 itself,
refuted with `wc -l` + grep evidence (no such duplicate existed) and dismissed per
the standing dismiss-a-stuck-reviewer authorization in Joe's global
`~/.claude/AGENTS.md` (**correction**, caught by `chatgpt-codex-connector` review on
this doc's own PR: there is no `AGENTS.md` in this repo — the authorization is
personal/global config, not a repo-local instruction file; the original draft's
"this repo's standing AGENTS.md authorization" was itself a small instance of the
exact false-repo-fact pattern this post-mortem is about). This is expected, not a fix
failure — at the point that review ran, `codexreviewbot` was still on the pre-#54
anthropic-only tuning, so the general stuck-loop susceptibility this fix doesn't claim
to eliminate was still present for it. It's evidence the two problems (false-premise
hallucination, and the reviewer's tendency to recycle a claim once made) are distinct
and only the first was targeted here.

## Blast-Radius Check

In response to the question "did we check for another one of these lines in the
other skills?" — audited all 8 other skill files (Tier 1: `code-reviewer.md`,
`pr-test-analyzer.md`, `security-sast.md`, `code-review-and-quality.md`; Tier 2:
`type-design-analyzer.md`, `comment-analyzer.md`, `security-auditor.md`,
`architect-review.md`) for the same failure class: a false project-specific
tech/file/function claim asserted as established fact about *this* codebase.

`grep -rniE "this project|the project('|s)? (has|uses|is|contains)" skills/*.md` and
`grep -rniE "our (codebase|project|system|application)|we use|the codebase
(uses|has|is)" skills/*.md` found zero matches outside `silent-failure-hunter.md`'s
already-fixed text. Running the history check once **per file** (not the aggregate
`git log --oneline -- skills/*.md`, which reports commits touching *any* matching
file without attributing them — flagged by `coderabbitai` review on this doc's own
PR) confirms the per-file commit counts: `silent-failure-hunter.md` has 2 (the
initial commit plus PR #53's fix), every other skill file has exactly 1. That makes
`silent-failure-hunter.md` the only skill with edit history beyond its own creation
commit — i.e. the only one that's ever needed a correction. The other 8 files are
either generic review-rubric prose with no project-tech claims at all, or explicitly
multi-language/multi-framework reference material (`security-sast.md` covers
Django/Flask/Express as illustrative examples of the class of vulnerability, never
asserted as *this* repo's actual framework). Checked and clean — not an assumption.

## What This Does NOT Fix

The bead's close note states plainly: "resolving/replying to threads alone does not
stop recycling" — tested directly on PR #44, it didn't work. That's a live, separate
problem on epic `ai-review-bot-9nv`, not resolved by this investigation.

The bead's close note pointed at `ai-review-bot-9nv`'s remaining follow-ups (`es0`,
`tbh`) as "new data" for that open thread. Re-examined against the question "is
either of those still necessary now that root cause is fixed, and does that change
its shape?" — the answer is no on both counts, and on closer read neither bead is
actually a hallucination follow-up:

- **`ai-review-bot-tbh`** (P2, open): when an `INCREMENTAL` triage pass has a clean
  delta (agents find nothing new) but prior findings remain unresolved, `buildReview`
  currently forces a fresh `REQUEST_CHANGES` post plus a summary LLM call on every
  such push, instead of re-stamping the existing check-run and skipping the repost.
  This is a **cost/noise optimization for legitimate, correctly-unresolved findings**
  — not a mitigation for false-finding recycling. Fixing 5zu's root cause neither
  satisfies nor reshapes `tbh`, because the two were never the same mechanism; `tbh`
  stands on its own independent merits (fewer redundant LLM calls and posts).
- **`ai-review-bot-es0`** (P3, open): three deferred minor code-cleanup items from
  PR1 — widen `OctokitLike.request`'s param type, thread real severity through
  instead of a hardcoded `'medium'` for inline findings, short-circuit agent fan-out
  on an empty `INCREMENTAL` delta. None of these bear on hallucinated findings or
  recycling at all.

The bead's own "new data point for es0/tbh" framing was looser than the mechanisms it
pointed at — worth correcting here rather than repeating uncritically.

## Prevention

- **Skill files that assert project-specific facts must be sourced from the actual
  diff or the project's own instruction files (`CLAUDE.md`/`AGENTS.md`), never
  vendored as static claims.** This is now explicit in `silent-failure-hunter.md`'s
  own text.
- **When a shared-surface fix targets one misbehaving consumer, verify the "the other
  one doesn't do this" premise with live evidence before scoping the fix narrowly** —
  PR #46's anthropic-only scoping was reasonable given the corpus available at the
  time (12 openai findings, too few to measure), but the premise it rested on had a
  known small-sample caveat that turned out to matter.
- **A stuck reviewer recycling a false claim across rounds, even after correction, is
  a distinct problem from a false premise baked into a skill** — fixing the premise
  (PR #53) does not by itself fix the recycling tendency (see codexreviewbot's new
  false claim on PR #53 itself, above). Track them separately; don't declare victory
  on one as evidence the other is solved.

## Links

- Bead: `ai-review-bot-5zu`
- PRs: [#53](https://github.com/joeblackwaslike/ai-review-bot/pull/53),
  [#54](https://github.com/joeblackwaslike/ai-review-bot/pull/54),
  [#46](https://github.com/joeblackwaslike/ai-review-bot/pull/46) (original
  claim-dedupe/reviewer-tuning, source of the 34% corpus stat),
  [#44](https://github.com/joeblackwaslike/ai-review-bot/pull/44) (peer-wait
  scheduling PR during which the fresh hallucination evidence was observed),
  [#25](https://github.com/joeblackwaslike/ai-review-bot/pull/25) (epistemic
  guardrails), [#21](https://github.com/joeblackwaslike/ai-review-bot/pull/21)
  (stuck-loop epic PR1), [#45](https://github.com/joeblackwaslike/ai-review-bot/pull/45)
  (800s timeout fix)
