# README Overhaul Implementation Plan

> **For agentic workers:** This plan's only file action is `Modify: README.md`
> (markdown, no source code touched). Per this repo's Docs-Only Override
> (`claude-extras.md`, "Plan Execution Docs-Only Override"), execute this
> plan **directly in-session, task by task** — do NOT invoke
> `superpowers:executing-plans` or `superpowers:subagent-driven-development`,
> and skip post-task code review, simplify, and lesson emission.

**Goal:** Rewrite README.md's messaging layer (hook, hero demo, pain framing,
value prop, proof, CTAs) per the locked spec, without touching the mechanics
documentation that's already accurate.

**Architecture:** Seven sequential, additive edits to a single 220-line file,
applied top to bottom. No new files (assets and `scripts/cost-report.sh`
already committed in a prior commit on this branch). One small necessary
addition outside the spec's explicit section list: a "try it locally" CLI
subsection, needed because the CTA links to it.

**Tech Stack:** Markdown only.

**Spec:** `docs/superpowers/specs/2026-08-24-readme-overhaul-design.md` — this
plan implements it verbatim except where noted; read the spec for the full
rationale behind every section.

## Global Constraints

- All new-section copy below is copied verbatim from the spec's `markdown`
  code blocks — do not paraphrase or "improve" it further; it already went
  through a self-review + cross-model adversarial pass.
- Tagline is **"Rigorous review for autonomous agents. $0.29 a review."**
  (not "a PR" — corrected post-spec).
- Existing sections (Two bots one deployment, How it works, Architecture,
  Quick start, Commands, Environment variables, Development, Local webhook
  testing, GitHub Action, Project structure, Contributing, License) are
  **out of scope** — carried forward with zero changes, except the one CLI
  addition in Task 6.
- Every new `##` heading must match GitHub's anchor-slug algorithm exactly
  since the CTA section links to some of them by anchor (`#quick-start`,
  `#cli--npm-package`, `#security`) — lowercase, spaces → single dash,
  punctuation stripped (`&` → removed, leaving a double space → double
  dash). Do not add punctuation to a heading that's a link target.
- No placeholders, no "TODO" — every step below has the literal final text.

---

### Task 1: Tagline + demo GIF (top of file)

**Files:**
- Modify: `README.md:1–15`

**Interfaces:**
- Consumes: `assets/demo.gif` (already committed, 3.1MB, 30s)
- Produces: nothing consumed by later tasks — purely additive content

- [ ] **Step 1: Insert the tagline and demo GIF between the badges block and the existing hook paragraph**

Current `README.md:9-11`:
```
[![Discord](https://img.shields.io/discord/1486035859747897414?logo=discord&label=Discord&color=5865F2)](https://discord.gg/Fjc9zYHZyV)

**ai-review-bot** ships two parallel AI code reviewers in one Vercel deployment
```

Replace with:
```
[![Discord](https://img.shields.io/discord/1486035859747897414?logo=discord&label=Discord&color=5865F2)](https://discord.gg/Fjc9zYHZyV)

### Rigorous review for autonomous agents. $0.29 a review.

![ai-review-bot driving a real PR from open to merge](assets/demo.gif)

*Real, not scripted — captured live from an actual autonomous Claude Code
session driving a real PR to a real merge.*

**ai-review-bot** ships two parallel AI code reviewers in one Vercel deployment
```

- [ ] **Step 2: Render-check** — open `README.md` in a Markdown previewer (or
  `gh browse` after pushing) and confirm the GIF renders and the tagline
  reads as a subhead, not a wall of text.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add tagline and demo GIF"
```

---

### Task 2: Pain section + scenario section + CTA (between hook and "Two bots")

**Files:**
- Modify: `README.md` (the `> **[Full documentation →]...` line and the blank
  line before `## Two bots, one deployment`)

**Interfaces:**
- Consumes: nothing new
- Produces: `#get-started` heading anchor (not linked-to by anything, purely
  informational); `#built-for-agents-that-ship-prs-not-people-who-review-them`
  (not linked-to either)

- [ ] **Step 1: Insert three new sections after the "Full documentation" line, before "## Two bots, one deployment"**

Current:
```
> **[Full documentation →](https://joeblackwaslike.github.io/ai-review-bot/)**

## Two bots, one deployment
```

Replace with:
```
> **[Full documentation →](https://joeblackwaslike.github.io/ai-review-bot/)**

## The old way

Your agent opens a PR, then goes idle. A human reviews it — 30 minutes,
sometimes longer — then has to remember to go tell the agent a review
landed, because the agent has no way to know on its own. The agent pushes a
fix, goes idle again. The human re-reviews, approves, tells it to merge.
Every round trip needs a human in the loop, and that's fine for one PR. It's
fatal once you're running more than one agent at a time.

## The new way

Two reviewers read every prior thread on the PR before commenting, so they
never repeat a finding you've already seen. They post only what's genuinely
new, with a priority and a fix block, directly as structured PR comments.
Your agent reads those comments itself and keeps going — no human nudge
required.

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
```
PR#812 opened, driving it to approval. Waiting for feedback.
Feedback for PR#812 received from anthropicreviewbot, fetching... CHANGES_REQUESTED. Triaging 1 of 2 findings...
Pushed commit #a3f9c21. Waiting for feedback.
Feedback for PR#812 received from anthropicreviewbot, fetching... APPROVED.
Feedback for PR#812 received from codexreviewbot, fetching... APPROVED.
PR#812 is Merged.
```
The demo GIF above shows a real, even faster example of the same loop — the
fix was clean enough that both bots approved on the first pass, no triage
round needed.

Run that loop N times in parallel, one per agent, one per PR — that's the
actual overnight workflow: not a single hero PR, a fleet of them, each held to
the same bar.

*(Still merging things yourself? The bots review just as well on a single PR —
install both GitHub Apps and every PR gets two independent opinions waiting
for you, no extra setup.)*

## Get started

- **[Try it on your own code, right now →](#cli--npm-package)** — `npx ai-review-bot review`, no setup, uses your existing Claude/Codex login, real review in your terminal in under a minute
- **[Install both GitHub Apps →](#quick-start)** — once you're sold, 2 minutes to get every PR reviewed automatically (works on public and private repos, see [Security](#security))
- **[Read the full docs →](https://joeblackwaslike.github.io/ai-review-bot/)**
- **[Join the Discord →](https://discord.gg/Fjc9zYHZyV)**

## Two bots, one deployment
```

*(Note: the transcript block above is a plain 6-line block with no code
fence in the actual README — it reads as prose-adjacent terminal output, not
a bash command, so don't add a ` ```bash ` fence around it; a bare ` ``` `
fence with no language tag, exactly as shown, is correct.)*

- [ ] **Step 2: Render-check** — confirm all three new `##` headings render,
  the embedded transcript block is legible (not swallowed into the
  surrounding paragraph), and the three CTA links use correct Markdown link
  syntax.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add pain section, scenario section, and CTA links"
```

---

### Task 3: "When not to use this" + Security (between Architecture and Quick start)

**Files:**
- Modify: `README.md` (the tier table at the end of "## Architecture" and the
  blank line before `## Quick start`)

**Interfaces:**
- Consumes: nothing new
- Produces: `#security` anchor — **must exist** before Task 2's CTA link to
  `[Security](#security)` resolves; if tasks are executed out of order, do
  Task 3 before or immediately after Task 2, not last.

- [ ] **Step 1: Insert both sections after the tier table, before "## Quick start"**

Current (end of Architecture section):
```
| `deep` | `deep-review` label | Opus + thinking | o3 high |

## Quick start
```

Replace with:
```
| `deep` | `deep-review` label | Opus + thinking | o3 high |

## When not to use this

- You need a single accountable human signoff for compliance/audit reasons —
  two bots are advisory, not a replacement.
- Your repo is sensitive and you're not comfortable sending diffs to
  Anthropic's/OpenAI's APIs — check your data-handling requirements first.
- You want zero false positives out of the box — LLM reviewers still restate
  or misfire occasionally; budget a few minutes to dismiss noise early on.

## Security

- Both bots authenticate as GitHub Apps, not PATs — least-privilege, scoped
  only to repos you install them on.
- Webhook payloads are verified via HMAC-SHA256 signature before any
  processing.
- API keys and GitHub App private keys live in Vercel env vars, never in the
  repo.
- Local CLI auth (`ai-review watch`/`review`/`audit`) is opt-in, personal-use
  only, and never wired into the webhook path (`src/auth.ts`).

## What does review actually cost?

Not a benchmark — run it on your own repo and get your own number:

```bash
./scripts/cost-report.sh owner/repo
```

It pulls every merged PR's bot reviews via `gh api`, parses the `$X.XX` each
bot prints in its own footer, and reports your real total/mean/median/min/max.
Not a fake 5-minute benchmark — the number is whatever your repo's real
history says.

On this repo (39 reviews across a recent PR run): **median $0.29/review**
($0.05–$1.64 range, pulled up by one legitimately large deep-tier PR).
Complexity tracks cost — normal-tier PRs median $0.15, complex-tier median
$0.44.

![Review cost by PR complexity](assets/cost-by-tier.svg)

That's the trade being made:
[Faros AI's 2026 AI Engineering Report](https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways)
found PRs merged with no review at all are up 31.3% and median time-in-review
is up 441.5% — *"reviewers cannot keep pace with the volume of AI-generated
code arriving for their attention."* Two bots at $0.29 a review is cheaper
than the alternative most teams are already living with.

Want the exact command that reproduces the $0.29 figure above?
`./scripts/cost-report.sh joeblackwaslike/ai-review-bot --prs 65,67-74`

## Quick start
```

- [ ] **Step 2: Verify the reproducing command still works** (it was verified
  during spec-hardening, but re-check after the file move to this worktree):

Run: `./scripts/cost-report.sh joeblackwaslike/ai-review-bot --prs 65,67-74`
Expected: JSON output with `"median_usd": 0.286617` and `"reviews": 39`

- [ ] **Step 3: Render-check** — confirm the SVG chart renders (GitHub
  renders inline SVG via `![]()` syntax fine) and the two new `##` headings
  plus the case-study section all appear correctly.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): add when-not-to-use, security, and cost case study sections"
```

---

### Task 4: Roadmap section (between Project structure and Contributing)

**Files:**
- Modify: `README.md` (the end of the "## Project structure" fenced block
  and the blank line before `## Contributing`)

**Interfaces:**
- Consumes: nothing new
- Produces: nothing consumed elsewhere

- [ ] **Step 1: Insert the Roadmap section after Project structure, before Contributing**

Current:
```
skills/
  code-reviewer.md
  silent-failure-hunter.md
  pr-test-analyzer.md
  security-sast.md
  code-review-and-quality.md
```

## Contributing
```

Replace with:
```
skills/
  code-reviewer.md
  silent-failure-hunter.md
  pr-test-analyzer.md
  security-sast.md
  code-review-and-quality.md
```

## Roadmap

Fleet-scale autonomy raises the stakes on guardrails — some of that already
ships: `ai-review watch`'s circuit breaker (stops itself after 3 reviews in 15
minutes) and head-SHA staleness checks that no-op a superseded run. Coming
next: a full merge-autonomy runbook for driving PRs to merge unattended, with
a clear, documented stop condition for when a bot's findings genuinely can't
be resolved automatically instead of looping forever.

## Contributing
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): add roadmap section"
```

---

### Task 5: Document the local `review` CLI subcommand (gap-fill, not in spec's explicit sections)

**Why this task exists:** Task 2's CTA promises `npx ai-review-bot review` as
a zero-setup "try it now" action linking to `#cli--npm-package`. The existing
"## CLI & npm package" section only documents the full-repo-audit command
(`npx ai-review-bot@latest owner/repo`) — the local `review` subcommand isn't
mentioned there at all. Without this task, the CTA links to a section that
doesn't back its own claim. This is a real gap found during planning, not
part of the original spec's locked copy — keep it minimal and factual, sourced
from `CLAUDE.md`'s existing description of `ai-review review`, not invented.

**Files:**
- Modify: `README.md:155-170` (the "## CLI & npm package" section)

**Interfaces:**
- Consumes: nothing new
- Produces: content backing Task 2's `npx ai-review-bot review` CTA link

- [ ] **Step 1: Insert a new subsection at the top of "## CLI & npm package," before the existing full-audit content**

Current:
```
## CLI & npm package

`ai-review-bot` is also published to npm as a standalone CLI that audits an entire repository — no PR, no webhook, no Vercel needed. It fetches all code files, runs the five agents in batches, and posts findings as a GitHub issue.

```bash
# one-off, no install required
npx ai-review-bot@latest owner/repo
```

Replace with:
```
## CLI & npm package

`ai-review-bot` is also published to npm as a standalone CLI.

### Try it locally first

No GitHub App, no webhook, no PR needed — review your current working tree
with whatever `codex`/`claude` subscription or API key you already have:

```bash
npx ai-review-bot@latest review
```

Writes a Markdown report to `docs/code-reviews/` and prints a summary to your
terminal. Auth resolves in order: API key → OAuth env token → your logged-in
`codex`/`claude` CLI subscription (personal use only — see
[`src/auth.ts`](src/auth.ts)).

### Full-repo audit

The CLI can also audit an entire repository — no PR, no webhook, no Vercel
needed. It fetches all code files, runs the five agents in batches, and posts
findings as a GitHub issue.

```bash
# one-off, no install required
npx ai-review-bot@latest owner/repo
```

- [ ] **Step 2: Verify the rest of the section still flows correctly** — read
  `README.md:155` through the `> **[Full CLI documentation →]...` line and
  confirm the "or install globally" / `ai-review owner/repo --ref main
  --dry-run` block (originally right after the first `npx` example) now sits
  correctly under "### Full-repo audit", not orphaned under the new "Try it
  locally first" subsection.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document the local review CLI subcommand"
```

---

### Task 6: Full read-through and link verification

**Files:**
- Modify: none (verification only)

**Interfaces:**
- Consumes: the fully-edited `README.md` from Tasks 1–5
- Produces: nothing — this is the plan's final gate

- [ ] **Step 1: Read the entire README top to bottom**

Confirm, in order: badges → tagline → demo GIF → hook paragraph → old
way/new way → scenario section → Get started → Two bots → How it works →
Architecture → When not to use this → Security → cost case study + chart →
Quick start → Commands → Environment variables → Development → Local webhook
testing → CLI & npm package (with the new "Try it locally first" subsection)
→ GitHub Action → Project structure → Roadmap → Contributing → License.

- [ ] **Step 2: Verify every internal anchor link resolves**

Check each of these appears as a heading whose GitHub slug matches the link:
- `[Try it on your own code...](#cli--npm-package)` → heading `## CLI & npm package`
- `[Install both GitHub Apps →](#quick-start)` → heading `## Quick start`
- `(see [Security](#security))` → heading `## Security`
- `(see [Security](#security))` (again, in the CTA bullet) → same

- [ ] **Step 3: Verify both images render**

```bash
grep -n '!\[' README.md
```
Expected: two matches — `assets/demo.gif` and `assets/cost-by-tier.svg` —
both paths relative to repo root, both files present (`ls assets/demo.gif
assets/cost-by-tier.svg`).

- [ ] **Step 4: Run repo quality gates** (README changes don't touch code, but
  confirm nothing else broke)

```bash
npm run typecheck && npm run lint && npm run test
```
Expected: all three pass clean (same as before this branch existed — no
source files were touched).

- [ ] **Step 5: Final commit if Step 4 required any fixes, otherwise done — no commit needed**

---

## Self-Review

**Spec coverage:** every spec section (demo GIF, pain, scenario, when-not-to-
use, security, case study, metrics chart, CTA, roadmap) maps to a task above.
Locked decisions (tagline, hook, architecture-diagram-unchanged) are covered
in Task 1 and the Global Constraints. The two "Flagged for your decision"
items are both resolved in the spec itself (tagline → "a review"; fleet claim
→ no change needed) so no separate task exists for them — the copy above
already reflects both resolutions.

**Placeholder scan:** no TODOs, no "add appropriate X" — every step has
literal final text or an exact runnable command.

**Type/anchor consistency:** `#cli--npm-package`, `#quick-start`, `#security`
anchors cross-checked against the actual heading text each task produces —
Task 3 produces `## Security` before Task 2's link to it is meaningful to a
reader (though Markdown doesn't care about link-target ordering within a
single file, so execution order 1→2→3→4→5→6 is fine as written; flagged only
because a reviewer might wonder).
