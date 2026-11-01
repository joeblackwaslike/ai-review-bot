---
epic: ai-review-bot-t0c
status: approved-plan, pending hardening
---

# Design: verified, context-aware reviews (precision + depth)

## Context

A deep-research report compared PR-Agent, Kodus and Anthropic's Claude Code review stack with ai-review-bot. Its core argument is that every peer runs a refutation check between generating a finding and posting it, and ai-review-bot does not. That missing check explains much of the Claude bot's poor precision: 4/10 right against Codex's 17/18 in the 2026-10-25 incident.

I checked the report's code claims against HEAD `997063e` with two Explore passes and read the cited code myself. Its direction is right. Several specifics are stale or wrong, and it missed two false-positive sources and one real bug. This epic is **new and independent** of the closed `ai-review-bot-w9b` epic. The report's "sprint N" labels are not used.

**The goal:** posted findings are (1) checked by a model that didn't write them and can read the file, (2) produced by finders that can look beyond the diff, and (3) free of the deterministic false-positive sources in the merge and anchor layers. The current lens-agent shape is kept until measurement justifies changing it.

### Report claims, as verified

| Claim | Verdict |
|---|---|
| No post-generation filter in the posting path; `confidence` required but never read; `/qc` judge is on-demand only | True |
| `trimPatch` 24k per file, no PR-wide budget; one model per PR tier for all agents; no CLAUDE.md/AGENTS.md loaded; PR body unfenced | True |
| Diff is cached across agents (CLAUDE.md says it isn't) | True; the CLAUDE.md line is stale |
| `REVIEW_DELAY_SECONDS=540`, `injectPRSection` feedback loop | Stale: both removed in #93 |
| "Off-diff anchors dropped silently" | False. They're listed in the body, but comments up to ±5 lines off are **moved** ([src/review.ts:1237](src/review.ts#L1237)). Missed false-positive source |
| `resolveStaleThreads` over-resolves | Real bug, worse than reported: it no longer matches the bot's badge-first comments, but does match human `**nit:**` threads and every file a delta round didn't touch. No author check, no test |
| Partial rounds advance the sha | Partly: per-skill pending exists, but sha always advances and a skill that ran on truncated input isn't marked pending |
| Matcher join rate 10/29 | Unverifiable: no join-rate metric exists |
| (missed) Distinct findings at the same `path:line` are folded into one comment ([src/review.ts:619-629](src/review.ts#L619-L629)) | A false positive rides along with a real finding |
| (missed) Strict-evidence prompt uses `high/medium/low` while the schema demands P0–P3 ([src/prompt.ts:266-282](src/prompt.ts#L266-L282) vs [src/review.ts:318](src/review.ts#L318)) | Contradictory instructions |

### Decisions (owner, this session)

1. **Verifier is cross-vendor.** Codex checks Claude's findings and Claude checks Codex's. Verdict comes first, a finding is dropped only on refutation, and the verifier sees the full head file.
2. **Agent restructure: measure, then decide.** A decision story is gated on per-skill data.
3. **Context: numbered diff lines plus tool-using finders.** One vendor-neutral tool set backed by Serena: locally over MCP stdio, hosted inside a Vercel Sandbox, with a GitHub-backed lexical fallback. Repo rules come from AGENTS.md/CLAUDE.md on the **default branch**.
4. **Hosted runs on Vercel Pro.** Max function duration goes from 300s to 800s. Sandbox Serena runs from a pre-baked snapshot.

## Disposition of every report recommendation

Status key: **Planned** = already a story above; **Added** = new story added in this revision; **Modified** = adopted with a change (reason given); **Deferred** / **Rejected** = not in this epic (reason given).

### Priority list (report §"What to adopt")

| # | Recommendation | Status | Story / reason |
|---|---|---|---|
| 1 | Cross-vendor, verdict-first, refute-to-drop verifier with full head file; fail open P0/P1, closed P2/P3 | Planned | S3, D1 |
| 1a | Hard-coded exclusions ("nothing to flag", verify-only titles) before any prompt work, with a test file | Planned | B5 (strict families only; the loose rule false-drops, measured) |
| 1b | Label incident findings as FP fixtures; track kept-real vs dropped-real | Planned | C2, S3 |
| 1c | QStash-chained invocation if latency doesn't fit | Modified | Pro's 800s replaces it; revisit only if S4 says it doesn't fit |
| 2 | Candidate gate + LLM "same occurrence" adjudicator for reworded repeats | Modified → F2 | Conditional: recycling measured at 7/188 (3.7%); build only if >5% after B1+B6 |
| 2a | Finder-declared link: optional `repeats_entry_id` in `ModelReviewSchema`, enum of shown ledger ids | **Added** | B7 (Kodus: finder links right 112/119) |
| 2b | Suppress restatements of *open* entries, still counting toward verdict | Planned | B6 |
| 2c | `caused_by_earlier` (ping-pong) findings linked to the earlier thread | **Added** | B7 (same schema field, `relation: repeats \| caused_by`) |
| 2d | Matcher join rate as a first-class replay metric | Planned | C2 |
| 3 | Conservative resolution: partial/truncated/capped runs never advance sha or resolve by absence | Planned | A4 (nothing resolves by absence today, verified) |
| 3a | Rebase/force-push handling (compare at orphaned commit, fall back to full) | **Added** | A6: test what a diverged compare does today, fix if it reviews upstream commits |
| 4 | Dynamic hunk context (5 before / 1 after, up to enclosing function) | **Added** | B10, folded into PR-wide diff packing; hosted fallback benefits most |
| 4a | Repo instructions from the default branch only | Planned | E6 |
| 4b | Treat PR title/body/commits as untrusted | Planned | A3 |
| 4c | Tool-using finders end state | Planned | E2–E5 |
| 5 | `confidence` used per finding to set verify depth, calibrated per (agent, category) | Planned (depth) / **Added** (calibration) | D1 uses it; calibration is part of F3 |
| 5a | Default severity floor for agent-driving mode + per-review comment budget | **Added** | B9, measured on replay as a hypothesis |
| 6 | Ledger outcomes drive per-(skill, category) health: ignored / noisy, proposal issue or pause after approval | **Added** | F3 (after C1, C3) |
| 7 | Structural fingerprint: category + path + rolling hash of whitespace-stripped anchor code; OR-match on suggestion code | Modified | B1 now hashes **anchor code**, not title text (title hashing would be wording-dependent, which defeats the point) |
| 8 | Replay overfit: held-out PR, clean-PR fixtures | Planned | C2 |
| 8a | Require eval evidence on PRs touching `src/review.ts`, `src/ledger/`, prompts | **Added** | C4 (PR template section + CI check that replay ran) |
| 9 | Cross-PR suppression, k-of-n | Deferred | Most churn is within one PR; revisit after F3 |

### "What to take from each"

| Source | Recommendation | Status | Story / reason |
|---|---|---|---|
| PR-Agent | Budget the review (max findings, empty list allowed) | **Added** | B9 |
| PR-Agent | Pack the diff deliberately: PR-wide budget, order by language/size, drop deletion-only hunks, list omitted files to the model; replaces `trimPatch` | **Added** | B10 |
| PR-Agent | Keep defects and improvements apart; readability/architecture findings non-blocking | **Added** | B11: `code-review-and-quality` and `architect-review` findings capped at P2 and excluded from REQUEST_CHANGES, independent of the F1 restructure |
| Kodus | Severity assigned by a separate fixed-rubric classifier, not the finder | **Added** | D2: the verifier also returns `severity` against a fixed rubric; measured for drift before it overrides |
| Kodus | Evidence gate: claims depending on code outside the diff get full verification | Planned | D1 depth rule (claim cites an identifier not in the diff → full verify) |
| Kodus | Small tool set before an index | Planned | E2/E3 |
| Kodus | Store discards with reason codes | Planned | C1 |
| Kodus | Rules first-class with mandatory quote | Planned | E6 |
| Kodus | Recall pass ("what did you miss") | Modified | Only if F1 consolidates agents; part of F1 |
| Anthropic | Model by role, not only PR tier | Planned | F1 |
| Anthropic | Redundancy with different framings + per-issue validator | Modified | Validator = D1; framing redundancy only if F1 consolidates |
| Anthropic | Copy the do-not-flag list (pre-existing, linter-catchable, lint-ignore-silenced, pedantic) | **Added** | A2 (prompt story widened) |
| Anthropic | CLAUDE.md compliance as its own cheap agent quoting the rule | Planned | E6 |
| Restructure | "Also found by" badge when both vendors agree | **Added** | D3 |
| Measurement | FP metric biased low by agent compliance; sample "fixed" entries for opposite-vendor adjudication | **Added** | C5 |
| Efficiency | OpenAI automatic prefix caching unconfirmed | **Added** | C1 logs cached-token counts per provider |

### gemini-review-action appendix

| # | Recommendation | Status | Story / reason |
|---|---|---|---|
| 1 | Line-numbered diffs + full head file; log anchor drop rate | Planned | B3, D1/E3 |
| 2 | Context selection: heuristic ranking + cheap planner + always-attached manifests and file tree | Modified | **Added** E7 for manifests + file tree in the cached prefix; planner Deferred because tools (E2) cover selection |
| 3 | `resolveStaleThreads` safety rules | Planned | A1 |
| 4 | Prompt rules: no version downgrades, no sweeping claims, input demarcation, no `$(…)`/backticks in shell suggestions | **Added** | A2 (+A3 for demarcation) |
| 5 | Suggestion cleanup: auto-correct range, align indentation, strip fences/line prefixes | **Added** | B12 (suggestions are posted verbatim today, `src/review.ts:1180`) |
| 6 | Count dropped anchors; redirect only P0/P1 | Modified | Drops are already listed in the body (verified); B4 keeps that and adds P0/P1 → general finding |
| 7 | 1h-TTL repo-context cache across runs | **Added** | E7 (once a stable repo-context block exists) |
| — | "Acknowledged but not applied" state: stays open, not re-argued | **Added** | B13 (no ack state today, verified) |

### "What not to copy" (all honored)

Self-scored 1–10 gates, publishing unvetted suggestions on reflection failure, run-once gates, a second stacked verify pass, and blanket category regex exclusions. None appear in the plan; D1 is the only verify pass.

### Added stories (summary)

- **A6** (S–M) rebase/force-push delta handling, test first
- **B7** (M) finder-declared `relation` + ledger id field
- **B9** (M) severity floor + per-review comment budget, replay-measured
- **B10** (M) PR-wide diff packing with hunk context, replaces `trimPatch`
- **B11** (S) quality/architecture findings non-blocking
- **B12** (S) suggestion range/indent/fence cleanup
- **B13** (S) acknowledged disposition
- **C4** (S) eval evidence required on pipeline PRs
- **C5** (S) opposite-vendor audit of sampled "fixed" entries
- **D2** (M) verifier severity re-assignment, drift-measured
- **D3** (S) "also found by" badge
- **E7** (S) manifests + file tree + 1h repo-context cache
- **F3** (M) ledger-outcome skill/category health
- A2 widened (do-not-flag list + gemini prompt rules); B1 changed to an anchor-code hash; B4 adds P0/P1 redirect

## Owner-only action

- **Upgrade the Vercel team to Pro.** This is a billing action only the account owner can take, needed before Phase E1 ships. Everything else is agent work.

## Global constraints

- `src/auth.ts` (subscription/OAuth) is never imported from webhook, verifier or tools modules. They take resolved auth from the caller, and hosted uses API keys only.
- Budget split under 800s: about 80s for fetch, triage and sandbox boot in parallel; agents 500s; verifier 100s; summary and post 120s. Never let agent budget plus verifier exceed about 650s.
- Every behavior change gets a failing test first (TDD). Every precision change gets a replay metric before/after. Fixture claims are small-sample (about 234 claims, about 71 rejected), so results are directional.
- The two-independent-opinions pitch is kept: finders stay independent, and the verifier can only **drop**, never add or rewrite. The review body shows "N dropped by the <other vendor> verifier". `VERIFY_ENABLED` toggles it per bot.

## Phases and stories

Sizes: S ≤ ½ day, M 1–2 days, L 3–5 days.

### Phase A: correctness bugs (ship first, one PR)

- **A1. Fix `resolveStaleThreads`** (M). [src/resolve-threads.ts](src/resolve-threads.ts), callsite [src/github-app.ts:721](src/github-app.ts#L721).
  - Test first, in a new `src/resolve-threads.test.ts`: a human `**nit:**` thread gets resolved today, and so does a qualifying thread in an untouched file on a delta round.
  - Fix: add `author { login }` and `databaseId` to `THREADS_QUERY`, and require the author to be the bot's login. Resolve only threads whose comment id is in the ids triage/`revalidateFindings` marked resolved ([src/triage.ts](src/triage.ts)). Delete the `validLinesByPath` heuristic.
  - AC: human threads are never resolved; untouched files are never resolved; only triage-resolved ids are resolved.
- **A2. Severity wording** (S). Replace `high/medium/low` in the strict-evidence block with P0–P3. AC: a snapshot test shows no `high`/`medium`/`low` as severity words.
- **A3. Fence untrusted text** (S). In `buildUserMessage` ([src/prompt.ts:198](src/prompt.ts#L198)) and the prior-reply text ([src/prompt.ts:62](src/prompt.ts#L62)), wrap the content in `<untrusted_pr_text>` and add a system rule telling the model to treat it as data. AC: an injection-string test.
- **A4. Partial rounds don't advance the sha** (M). Add an `ai-review:complete=0` marker in `formatReviewBody` ([src/review.ts:1114](src/review.ts#L1114)), honored by `deriveBaseline` ([src/baseline.ts](src/baseline.ts)). Truncated input marks the skill pending. Mirrors [src/gate/round.ts:283](src/gate/round.ts#L283). AC: a deadline abort makes the next round re-review the full range, with no double posting (the ledger catches it).
- **A5. Doc fix** (S). Correct the CLAUDE.md line "user message (diff) is not cached".

### Phase B: deterministic precision

- **B1. Per-finding fingerprint** (M). Add a hidden `ai-review:fp=<category|path|rolling hash of the whitespace-stripped ~100-char anchor-code window, with an occurrence suffix (CodeQL primaryLocationLineHash style)>` in `buildCommentBody`, plus a second marker hashing the suggestion code (OR-match). Make an exact-fingerprint match rule 0 in `findSettledMatch`/`findOpenMatch` ([src/ledger/match.ts](src/ledger/match.ts)). AC: a reworded finding with the same fingerprint matches, and the existing ledger tests still pass.
- **B2. Stop folding at the same path:line** (S, after B1). `mergeReviewsDetailed` posts distinct claims separately; `isSameClaim` still collapses restatements. AC: two claims produce two comments with two provenance entries.
- **B3. Numbered diff lines** (M). `serializeFiles` prints right-side numbers, reusing the `collectRightSideLines` walk, and the "count from @@" rule ([src/prompt.ts:299](src/prompt.ts#L299)) is replaced. AC: anchor-adjust log rate drops by 80% or more on `replay --live`, with token growth of 15% or less.
- **B4. Drop instead of re-anchoring** (S, after B3). Delete `nearestValidLine` and the ±5 branch in `sanitizeInlineComments`. AC: an off-diff comment is dropped and logged with a reason.
- **B5. Retraction filter in the posting path** (S). Move the strict families from [src/replay/retraction-rule.ts](src/replay/retraction-rule.ts) to `src/retraction.ts`, applied to P2/P3 suppressible findings after suppression. AC: the filter-margin report still shows 5/15 removed with 0 false drops.
- **B6. Suppress restatements of open entries** (M, after B1). `suppressOpenRestatements` sits beside `suppressSettled` ([src/ledger/suppress.ts](src/ledger/suppress.ts)) and reuses `findOpenMatch`. Suppressed findings **still count toward the verdict**. AC: replay `restated-open` drops to about 0, and a verdict test passes.

### Phase C: measurement (before the expensive work)

- **C1. Persist discard reasons** (M). `SUPPRESSED_SETTLED | SUPPRESSED_OPEN | RETRACTION | OFF_DIFF | CAP | DISCARDED_BY_VERIFY` go to [src/agent-log.ts](src/agent-log.ts) and a nullable column in [src/improve/db/schema.ts](src/improve/db/schema.ts). AC: a migration and a repo test.
- **C2. Replay additions** (M). A join-rate metric in [src/replay/metrics.ts](src/replay/metrics.ts); 2 or more held-out PRs and 2 or more clean-PR fixtures recorded with `--record`; verifier kept-real/dropped-real per vendor pair. AC: `computeMetrics` reports them, and clean fixtures expect 0 posted findings.
- **C3. Per-skill rates and leave-one-lens-out** (M, after B1–B2). Corpus rows written after B2 only (backfilled `skills` is empty). Leave-one-lens-out runs through cost-capped `replay --live`. Output: a table per skill of rejected, restated and fixed counts.

### Phase D: cross-vendor verifier

- **Spike S3 first.** Run the verifier prompt offline over the labelled fixtures with cheap (haiku/luna) and mid tiers. Pick the tier by kept-real/dropped-real. This covers the Uber result that grader choice moves F1 by 4.5 points, and the warning in the `qc.ts` comment that one vendor's style may mark down the other's.
- **D1. `src/verify.ts`** (L, after C1–C2 + S3).
  - Placement: after merge, dedupe and off-diff drop; before the 50-comment cap.
  - `generateObject` with schema `{ refuted: boolean, reason: enum, rationale }`. The verdict comes first. The reason enum is: wrong root cause, impossible path, pure style, generic "missing X", contradicts a settled ledger entry.
  - Input: the full head file (contents API, or the checkout locally) plus related ledger entries.
  - `confidence` decides how deep to verify.
  - Fail open for P0/P1 and closed for P2/P3. A verifier outage marks the round partial (A4) and adds a body notice.
  - Rewrite the `judgeSelection` comment in [src/improve/qc.ts](src/improve/qc.ts): QC stays same-provider as a measurement, the verifier is cross-vendor as a filter.
  - AC (offline): drops at least 40% of confirmed-rejected; 0 confirmed-fixed P0/P1 dropped; at most 5% of fixed P2/P3 dropped.

### Phase E: context (Pro needed for E1)

- **E1. Pro budget** (S). Raise `maxDuration` to 800 in `vercel.json` for `webhook.ts`, `webhook-openai.ts` and `review-run.ts`. Apply the budget split; add `REVIEW_VERIFY_BUDGET_SECONDS`.
- **Spike S1.** Check that `generateText` + `Output.object` + `tools` + `stopWhen: stepCountIs(n)` works on both providers: API key, and the Codex OAuth SSE wrapper ([src/auth.ts:342](src/auth.ts#L342)). `prepareStep` returns `activeTools: []` on the last step to avoid `NoOutputGeneratedError`.
- **Spike S4.** Measure tool-loop step latency on the largest fixture (stealth-browser#1) to confirm 5–9 agents at concurrency 4 fit in 500s.
- **E2. Vendor-neutral tool set** (L, after S1/S4). `src/tools/` exposes `find_symbol`, `find_references`, `symbols_overview`, `read_file` and `search`, with a backend chosen at runtime. `runAgent` moves to `generateText` with output, step cap, `timeout.stepMs` and identical tool defs, so the cache prefix holds. Update the "you see only the diff" guardrails. AC: on `replay --live`, more cross-file findings get fixed and the rejected rate doesn't rise.
- **E3. GitHub lexical backend** (M). Contents API plus code search at the head SHA. It doubles as the fallback, so build it first.
- **E4. Local Serena backend** (M). Add `@ai-sdk/mcp`; stdio `serena start-mcp-server --project <checkout>` in a read-only mode. `watch` creates a worktree at the PR head.
- **Spike S2.** Time snapshot boot plus shallow clone plus Serena/LSP indexing on two real repos. Target: under 60s.
- **E5. Hosted Sandbox Serena** (L, after S2 + Pro). Add `@vercel/sandbox`. Boot from a pre-baked snapshot (Serena + language servers), clone with a read-only installation token, start the boot in parallel with the PR fetch, fall back to E3 on any failure. Add a privacy line to the docs: repo code is processed in Vercel compute.
- **E6. Repo-rules check** (M). Load AGENTS.md/CLAUDE.md from the default branch, fenced. A finding that cites a rule must quote it, and the quote is checked as a substring. AC: a fabricated quote gets the finding dropped.

### Phase F: decision gates

- **F1. Restructure decision** (S). Restructure into one defect finder plus non-blocking lenses capped at P2 only if C3 shows lens agents produce at least 50% of rejected findings while contributing less than 20% of fixed ones. Per-role routing in `routeModel` ([src/router.ts:95](src/router.ts#L95)) gets stronger models for the defect and security agents either way, if C3 supports it.
- **F2. Conditional reworded-repeat adjudicator.** Only if recycling is above 5% after B1 and B6.

**Order:** A (A1–A6) → B (B1–B13) → C (C1–C5) → (S3 → D1–D3) ∥ (S1, S4 → E3 → E2 → E4; S2 + Pro → E5) → E6, E7 → F1–F3. Full story list with dispositions is in "Disposition of every report recommendation" above.

## Execution workflow

1. Create `.worktrees/review-precision-epic`. Write the spec `docs/superpowers/specs/2026-10-31-verified-context-aware-reviews-design.md` from this plan. Harden it with a self-adversarial pass and a `codex:codex-rescue` pass. It is the first commit on the Phase A branch.
2. Create the bd epic and one child per story, with `bd dep add` edges matching the order above. Spikes are `--type=spike`.
3. Each phase goes through `superpowers:writing-plans`, then `superpowers:subagent-driven-development`, then `ai-review review --full` (two passes), then `/no-mistakes`, then `/pr-loop` to merge. One PR per phase.

## Verification

- Every story: `pnpm typecheck && pnpm lint && pnpm test` green, with the failing test shown first.
- Precision stories: `ai-review replay` before/after (rejected-of-adjudicated, restated-open, join rate, filter margin, verifier kept/dropped-real), plus cost-capped `replay --live` for B3, C3, D1 and E2.
- A1 and E5: a live check on a throwaway PR. Human `**nit:**` threads stay open; Sandbox boot time and fallback show up in the logs.
- End of epic: run both bots on 3 real PRs and compare against the incident baseline (Claude 4/10).

## Critical files

[src/review.ts](src/review.ts), [src/prompt.ts](src/prompt.ts), [src/resolve-threads.ts](src/resolve-threads.ts), [src/ledger/match.ts](src/ledger/match.ts), [src/ledger/suppress.ts](src/ledger/suppress.ts), [src/baseline.ts](src/baseline.ts), [src/improve/qc.ts](src/improve/qc.ts), [src/replay/metrics.ts](src/replay/metrics.ts), [src/router.ts](src/router.ts), `vercel.json`. New: `src/verify.ts`, `src/retraction.ts`, `src/tools/`.
