# README / repo messaging overhaul

**Status:** drafted, pending sign-off
**Spec:** this file (`docs/superpowers/specs/2026-08-24-readme-overhaul-design.md`)
**Process:** `viralize` skill, architectural path per `superpowers:brainstorming`

## Why

The current README undersells the product. It documents the mechanics (two bots,
five agents, merge logic) but never states the actual value proposition or gives
a reader a reason to care in the first ten seconds. This overhaul rewrites the
messaging layer — hook, hero visual, pain framing, proof, and CTAs — without
touching the mechanics documentation that's already accurate (Architecture,
Commands, Environment variables, CLI & npm package, Project structure sections
are explicitly **out of scope**, carried forward as-is).

## Locked creative decisions

- **Hook:** two independent AI reviewers (Claude + Codex, separate GitHub Apps,
  separate bot identities) reviewing every PR in parallel.
- **Audience:** agentic developers. **Not** a human-code-review-habits ladder —
  the target reader is not manually reviewing PRs. The value proposition is
  catching bad agent-written code before it merges. (Corrected mid-brainstorm
  from an earlier draft that wrongly framed this as a 3-tier "sophistication
  ladder" from manual review → autonomous; see "Scenario section" below for the
  corrected framing.)
- **Core pain (the "old way"):** every PR review round is a manual human
  handoff — agent opens PR, goes idle, human reviews 30+ min, manually tells the
  agent to go check, agent has no way to know a review landed on its own, agent
  pushes a fix, idle again, human re-reviews/approves/tells it to merge. The
  human is the blocking synchronization point in an otherwise autonomous loop —
  and that bottleneck is fatal, not just annoying, once you're running more than
  one agent at a time.
- **The fix (mechanism):** two reviewers read all prior review threads first (no
  duplicate findings — `buildReview`'s triage gate, real), post only genuinely
  new findings inline with priority + fix blocks, agent reads structured PR
  comments directly and iterates without waiting on a human nudge.
- **Tagline:** "Rigorous review for autonomous agents. $0.29 a review." (changed
  from "a PR" → "a review" 2026-08-24, to match the actual unit of the data —
  see "Flagged for your decision" below, now resolved.)
- **Logo:** Direction D (minimal wordmark, one continuous gradient across
  "ai-review-bot", `ui-monospace` font), gradient variant 3 — dark
  `#ff8a5c → #1fd8a4`, light `#c1573a → #0d8a68`. *(Not yet produced as an
  asset — needs a follow-up task in the implementation plan.)*
- **Architecture diagram:** reuse the current README's existing ASCII diagram
  as-is, no change.

## Flagged for your decision

1. **Tagline unit mismatch — resolved 2026-08-24.** Changed "$0.29 a PR" →
   "$0.29 a review," matching the actual unit of the underlying data (a PR
   gets 2 reviews, one per bot, so a PR's total review cost is closer to
   ~$0.55–0.60 — "a review" is the honest unit).

2. **"Waking up to all of them merged" vs. Roadmap's "coming next" —
   resolved 2026-08-24, false alarm.** The cross-model review (and my own
   read of it) assumed "waking up to all of them merged" implied a built-in
   fleet-orchestration *feature* that doesn't exist yet, in tension with the
   roadmap calling the merge-autonomy runbook "coming next." That's a
   misreading — the copy never claimed a fleet feature. It describes
   something Joe has actually done: 8 PRs merged overnight, back-to-back-to-
   back, by running the real single-PR loop across multiple sessions
   himself. That's already true today, not aspirational — no reword needed.
   The roadmap item is about *guardrails* for that pattern (shared circuit
   breakers, a documented stop condition), not about the pattern itself not
   existing.

## New sections / content (all copy below is final, drafted and approved)

### 1. Demo GIF

`assets/demo.gif` (3.1MB, 30s) + `assets/demo.tape` (VHS source). **Real
footage, not scripted** — captured from an actual live Claude Code session
autonomously driving a real toy PR
(`joeblackwaslike/ai-review-bot-demo#3`) from open to merge against the real
production bot identities, using `ai-review watch` to keep review turnaround
fast instead of the hosted webhook's ~9 min default delay. Two-part clip: the
opening ask + real diff fix (0–18s), cut to the final approve/merge narration
(18–30s). Placed as the hero visual near the top, under the tagline.

Also captured but not yet used: `assets/pr-review-live.webm` (browser
recording of the actual GitHub PR page as a review posted live) and six PR-page
screenshots — available for a splice/cutaway if a future revision wants to show
the GitHub UI side of a review landing, not just the terminal.

### 2. Pain section ("the old way" vs "the new way")

Uses the Core pain / fix framing above, verbatim. Placed after the hook,
before the architecture section.

### 3. Scenario section — "Built for agents that ship PRs, not people who review them" (replaces any ladder/tier framing)

```markdown
## Built for agents that ship PRs, not people who review them

If you've ever pointed a review agent at another agent's PR, you know the
quality bar is rough — real bugs, silently swallowed errors, missing test
coverage, security gaps. That's the gap ai-review-bot closes: two independent
reviewers (Claude + Codex) on every PR, so bad agent code gets caught before a
human ever has to look at it.

The real target isn't reviewing one PR faster — it's running a fleet of
agents overnight. I've done 8 PRs back-to-back while asleep, each one
driving itself through real review and real fixes, not a rubber-stamp.

Here's what that loop looks like in practice — the shape is real (this is the
exact narration format a driving agent uses), a representative run:
\`\`\`
PR#812 opened, driving it to approval. Waiting for feedback.
Feedback for PR#812 received from anthropicreviewbot, fetching... CHANGES_REQUESTED. Triaging 1 of 2 findings...
Pushed commit #a3f9c21. Waiting for feedback.
Feedback for PR#812 received from anthropicreviewbot, fetching... APPROVED.
Feedback for PR#812 received from codexreviewbot, fetching... APPROVED.
PR#812 is Merged.
\`\`\`
The demo GIF above shows a real, even faster example of the same loop — the
fix was clean enough that both bots approved on the first pass, no triage
round needed.

Run that loop N times in parallel, one per agent, one per PR — that's the
actual overnight workflow: not a single hero PR, a fleet of them, each held to
the same bar.

*(Still merging things yourself? The bots review just as well on a single PR —
install both GitHub Apps and every PR gets two independent opinions waiting
for you, no extra setup.)*
```

**Adversarial finding, fixed (twice):** the first draft used a placeholder
"PR#812" in this transcript right next to the demo GIF, which shows the real
"PR#3" — a reader would notice the mismatch and doubt the "captured live"
claim. The first fix attempt tried to patch this by rewriting the transcript
to match PR#3's *actual* events — but PR#3 went straight to double-`APPROVED`
with **zero** triage (both bots approved on the first pass; verified via `gh
pr view 3 --repo joeblackwaslike/ai-review-bot-demo --json reviews`), so a
"CHANGES_REQUESTED → triage → push" transcript never happened on that run,
and the commit SHA in that first fix attempt (`#eda06d5`) was fabricated, not
looked up. The real SHA for PR#3's fix commit is `9453425`
(`fix: return max when clamp value exceeds upper bound`). Rather than force a
fake triage round into a transcript claimed to be "the GIF, transcribed,"
this version keeps the illustrative `#812` example (representative of what
PR #1 and PR #2 in the demo repo actually needed — real fixes, real triage)
and is explicit that the GIF itself shows a simpler, real, zero-triage case.
Nothing here is fabricated; the two are just honestly labeled as separate
things.

### 4. When not to use this

```markdown
## When not to use this

- You need a single accountable human signoff for compliance/audit reasons —
  two bots are advisory, not a replacement.
- Your repo is sensitive and you're not comfortable sending diffs to
  Anthropic's/OpenAI's APIs — check your data-handling requirements first.
- You want zero false positives out of the box — LLM reviewers still restate
  or misfire occasionally; budget a few minutes to dismiss noise early on.
```

### 5. Security

```markdown
## Security

- Both bots authenticate as GitHub Apps, not PATs — least-privilege, scoped
  only to repos you install them on.
- Webhook payloads are verified via HMAC-SHA256 signature before any
  processing.
- API keys and GitHub App private keys live in Vercel env vars, never in the
  repo.
- Local CLI auth (`ai-review watch`/`review`/`audit`) is opt-in, personal-use
  only, and never wired into the webhook path (`src/auth.ts`).
```

### 6. Case study — reproducible cost calculator

`scripts/cost-report.sh` (new, written and tested against both the real
`ai-review-bot` repo and the throwaway `ai-review-bot-demo` repo — see
"Verification" below). Usage:

```bash
./scripts/cost-report.sh owner/repo              # scans every merged PR
./scripts/cost-report.sh owner/repo --prs 65,67-74   # scans an exact PR range
```

Pulls the selected PRs' bot reviews via `gh api`, parses the `$X.XX` each bot
prints in its own footer, reports real total/mean/median/min/max — no
fabricated numbers, no canned benchmark.

**Adversarial finding, fixed:** the first draft of this section quoted "$0.29"
as if running the bare `./scripts/cost-report.sh owner/repo` on this repo
would reproduce it. It doesn't — that scans *every* merged PR (148 reviews,
median $0.216 as of this writing), not the specific #65/#67-74 window the
$0.29 figure was pulled from. Added the `--prs` flag so the README can give
the *exact* command that reproduces $0.29 on this repo
(`./scripts/cost-report.sh joeblackwaslike/ai-review-bot --prs 65,67-74` —
verified to output `median_usd: 0.286617`, `reviews: 39`, matching the locked
raw data exactly), while the bare form remains the honest "get your own
number for your own repo" pitch.

```markdown
## What does review actually cost?

Not a benchmark — run it on your own repo and get your own number:

\`\`\`bash
./scripts/cost-report.sh owner/repo
\`\`\`

It pulls every merged PR's bot reviews via `gh api`, parses the `$X.XX` each
bot prints in its own footer, and reports your real total/mean/median/min/max.
Not a fake 5-minute benchmark — the number is whatever your repo's real
history says.

On this repo (39 reviews across a recent PR run): **median $0.29/review**
($0.05–$1.64 range, pulled up by one legitimately large deep-tier PR).
Complexity tracks cost — normal-tier PRs median $0.15, complex-tier median
$0.44.

That's the trade being made:
[Faros AI's 2026 AI Engineering Report](https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways)
found PRs merged with no review at all are up 31.3% and median time-in-review
is up 441.5% — *"reviewers cannot keep pace with the volume of AI-generated
code arriving for their attention."* Two bots at $0.29 a review is cheaper
than the alternative most teams are already living with.
```

Raw cost data backing the $0.29 figure (n=39, PRs #65/#67-74, pulled the same
way the script does): total=$17.68, mean=$0.4533, median=$0.286617 → "$0.29",
range $0.049648–$1.638867 → "$0.05–$1.64". Median used deliberately — mean is
pulled up by PR #65 (legitimately large, the original deep-tier PR introducing
`watch`).

### 7. Metrics chart

`assets/cost-by-tier.svg` — static SVG (not interactive; embeds directly in
GitHub-rendered markdown via `<img>`/image syntax). Built per the `dataviz`
skill: single sequential blue hue (magnitude, not identity — no legend needed),
floating min–max range bars with a median tick, direct labels on median only.
Trivial and Deep tiers rendered as explicit dashed "no data" placeholders
(zero real samples in the sampled window) rather than estimated — per-tier
breakdown (PRs #40-74, classified via `classifyTier()` exactly, #52/#57/#64/#66
excluded as 404/never-opened):

| Tier | n | Median | Mean | Min | Max |
|---|---|---|---|---|---|
| Trivial | 0 | — | — | — | — |
| Normal | 78 | $0.1531 | $0.1640 | $0.0327 | $0.9519 |
| Complex | 117 | $0.4365 | $0.5053 | $0.0496 | $1.8070 |
| Deep | 0 | — | — | — | — |

Placed alongside or just below the case-study section.

### 8. CTA links

```markdown
## Get started

- **[Try it on your own code, right now →](#cli--npm-package)** — `npx ai-review-bot review`, no setup, uses your existing Claude/Codex login, real review in your terminal in under a minute
- **[Install both GitHub Apps →](#quick-start)** — once you're sold, 2 minutes to get every PR reviewed automatically (works on public and private repos, see [Security](#security))
- **[Read the full docs →](https://joeblackwaslike.github.io/ai-review-bot/)**
- **[Join the Discord →](https://discord.gg/Fjc9zYHZyV)**
```

**Adversarial finding, fixed:** the first draft led with "Install both GitHub
Apps" — pure setup friction with no payoff, before the reader has any reason
to believe it's worth the two minutes. Reordered to lead with the local CLI
review instead: zero setup, uses credentials the reader already has, and
produces a real result (an actual review, in their own terminal, on their own
code) in under a minute — the "it just worked" moment a CTA needs before it
asks for an install. GitHub App install moved to the second slot, for once
that trust is established.

Placed near the top, directly under the hook/badges, before "Two bots, one
deployment."

### 9. Roadmap

```markdown
## Roadmap

Fleet-scale autonomy raises the stakes on guardrails — some of that already
ships: `ai-review watch`'s circuit breaker (stops itself after 3 reviews in 15
minutes) and head-SHA staleness checks that no-op a superseded run. Coming
next: a full merge-autonomy runbook for driving PRs to merge unattended, with
a clear, documented stop condition for when a bot's findings genuinely can't
be resolved automatically instead of looping forever.
```

Placed near the bottom, as an earned payoff after the fleet-scale pitch — not
the hero message. Deliberately limited to the one roadmap item that's actually
locked in; no speculative padding.

## Verification already performed during brainstorming

Because this spec makes factual claims (the demo GIF is real, the cost script
works, the per-tier numbers are real), the following was independently
verified, not asserted:

- **`scripts/cost-report.sh`** ran successfully against `joeblackwaslike/ai-review-bot`
  (148 reviews found, real numbers returned) and against the throwaway
  `joeblackwaslike/ai-review-bot-demo` repo (15 reviews, real numbers
  returned). Output format and field names confirmed correct after an initial
  bug (`endswith("reviewbot")` missed the `[bot]` GitHub suffix; fixed to
  `contains("reviewbot")`).
- **`./scripts/cost-report.sh joeblackwaslike/ai-review-bot --prs 65,67-74`**
  (the exact command the README will tell readers to run) verified to output
  `reviews: 39`, `median_usd: 0.286617`, `total_usd: 17.68`, matching the
  locked raw data exactly.
- **A cross-model adversarial pass** (`codex:codex-rescue`, GPT-5) reviewed
  this spec and `scripts/cost-report.sh` in full. It found: two real script
  bugs (`--prs` with no value crashed instead of erroring cleanly; a
  zero-results case — either no matching reviews or a `gh api` 404 — aborted
  the whole script under `set -euo pipefail` instead of reaching the friendly
  "no reviews found" message) — both fixed and re-verified above; a
  PR-number/commit-SHA mismatch between the scenario section's transcript and
  the actual demo GIF footage — fixed (see the scenario section's own
  "Adversarial finding, fixed (twice)" note for the full story, including a
  fabricated SHA I introduced in the first fix attempt and caught before it
  shipped); an ordering problem (CTA before the pitch, scenario section buried
  after mechanics, License listed twice) — fixed; several copy softenings
  (see below); and two locked-copy tensions — flagged above for your decision
  rather than resolved silently. The cost regex was also tightened from
  matching any `$N.NN` to requiring the exact 6-decimal format the bots
  actually print, and the bot-login match and PR-range parsing were hardened
  against malformed input.
- **The demo GIF's narration** (the payoff segment: two `APPROVED` lines +
  "PR#3 is Merged.") is a byte-for-byte match to real output from a real
  autonomous Claude Code session driving `ai-review-bot-demo` PR #3 to a real
  merge, confirmed via the GitHub API (`reviewDecision: APPROVED`, `mergedAt`
  set, both bot reviews `APPROVED` with zero triage needed) and via extracted
  video frames.
- **The per-tier cost table** numbers are carried forward unchanged from the
  original cost-data pull described in the brainstorming session (n=39/78/117
  samples, `classifyTier()`-based), not re-derived here — disclosed, not
  hidden, as a limit on what "verified" means for that one table.
- **"I've done 8 PRs back-to-back while asleep"** is a first-person
  claim from Joe, not independently re-derived or fact-checked in this
  session — same disclosure as the per-tier table above.

## Suggested top-to-bottom section order

Placement was specified relative to neighbors throughout this doc; spelled out
end-to-end here to remove ambiguity for the implementation plan (still
adjustable — this is a suggestion, not a locked layout):

1. Badges (existing, unchanged)
2. Hook + tagline (existing hook paragraph, updated with locked tagline)
3. Demo GIF
4. Pain section (old way / new way)
5. Built for agents that ship PRs... (scenario section) — kept next to the
   pain section since it's the same argument continued, not mechanics
6. Get started (CTA links) — after the reader is sold, not before
7. Two bots, one deployment (existing, unchanged)
8. How it works (existing, unchanged)
9. Architecture (existing ASCII diagram, unchanged)
10. When not to use this
11. Security
12. What does review actually cost? (case study) + metrics chart
13. Quick start → Project structure (existing middle sections, unchanged)
14. Roadmap
15. Contributing → License (existing, unchanged — confirm still last)

**Adversarial finding, fixed:** the first draft put "Get started" at position
4 (before the pain/scenario sections even ran) and buried the scenario
section at position 9, after the mechanics sections — asking for install
before making the case, and burying the actual value prop under
implementation detail. Also had "Quick start → License" and a separate
"Contributing / License" as two different entries, implying License appears
twice. Reordered so pain → scenario run together and lead (not CTA), CTA
comes after, and License is listed exactly once, at the end.

## Explicitly out of scope for this overhaul

- Architecture, Commands, Environment variables, Development, Local webhook
  testing, CLI & npm package, GitHub Action, Project structure, Contributing,
  License sections — carried forward unchanged.
- The logo asset itself (direction/gradient are locked, but no SVG/PNG has
  been produced yet — needs its own task).
- Any splice of `pr-review-live.webm` / the PR-page screenshots into the demo
  GIF — captured as available raw material, not committed to being used.

## Open items for the implementation plan

- Produce the logo asset (Direction D, gradient variant 3, both light/dark).
- Decide exact placement/ordering of all sections in the final README (this
  spec fixes content and rough placement, not a byte-exact diff).
- Commit `assets/demo.gif`, `assets/demo.tape`, `assets/cost-by-tier.svg`,
  `scripts/cost-report.sh` (all currently uncommitted working files) alongside
  the README changes, in one branch/PR per `working-with-git` convention.
- Confirm whether `pr-review-live.webm` / PR-page screenshots get used or
  discarded.
