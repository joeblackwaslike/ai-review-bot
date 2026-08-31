# Phase 1 Design Spec: Product-Grade PR Review Output

**Status:** Draft  
**Date:** 2026-08-31  
**Phase:** Greptile Parity Roadmap — Phase 1  
**Roadmap ref:** [docs/greptile-parity-roadmap.md](../../greptile-parity-roadmap.md)

## Goal

Make every review readable, triageable, and easy to act on. Phase 1 produces the clean event stream that Phase 4 (adaptive feedback) and Phase 8 (analytics) will consume — getting the schema right here avoids a painful migration later.

## Scope

Five deliverables, shipped in two sequential PRs:

- **PR 1 — Schema + Severity:** Finding schema v2 (new fields + P0-P3 scale), skill prompt updates, migration shim for KV-persisted findings.
- **PR 2 — Template + Metadata:** Deterministic `formatReviewBody()`, readiness score, review counter, hidden metadata block, command hints.

PR 2 depends on P0-P3 being live (severity labels drive the readiness score). Ship and verify PR 1 before opening PR 2.

## Non-goals

- Repository indexing or cross-file context (Phase 2).
- Suppression memory or feedback loops (Phase 4).
- Dashboard or analytics (Phase 8).
- GitLab or provider expansion (Phase 9).

---

## Deliverable 1: Finding Schema v2

### New fields on every finding

Both `general_findings` and `inline_comments` gain four fields:

```ts
category:     z.enum(['bug', 'security', 'performance', 'test-gap',
                       'architecture', 'style', 'nitpick'])
confidence:   z.number().min(0).max(1)   // agent self-assessment, 0.0–1.0
evidence:     z.string()                 // code path, observable behavior, or reference
suppressible: z.boolean()                // agent declares whether a team could mute this class
```

`evidence` is required and non-empty — agents must cite the specific code, call site, or observable behavior that supports the finding. A finding with no evidence is a guess; the schema enforces that agents commit to one.

`suppressible` is an agent judgment call, not a derived field. Agents are better positioned than heuristics to know whether a nitpick about naming convention is genuinely optional vs. whether a "style" issue is actually a correctness trap in disguise.

### Severity scale: P0–P3

Replace `["high", "medium", "low"]` with `["P0", "P1", "P2", "P3"]`:

| Level | Meaning | Suppressible |
|-------|---------|--------------|
| P0 | Critical — crash, data loss, auth bypass, RCE | Never |
| P1 | High — correctness bug with real user impact | Rarely |
| P2 | Medium — important but not immediately blocking | Sometimes |
| P3 | Low / nitpick — style, naming, docs | Default |

Emoji map:

```ts
{ P0: "🔴", P1: "🟠", P2: "🟡", P3: "🟢" }
```

Agents must never mark a `P0` finding as `suppressible: true`. The skill prompts enforce this explicitly.

### Breaking changes and migration

**`SEVERITY_LEVELS` tuple** (`review.ts:249`) — replace `["high", "medium", "low"]` with `["P0", "P1", "P2", "P3"]`. All downstream maps keyed on `Severity` update automatically via TypeScript exhaustiveness.

**KV-persisted `PersistedFinding.severity`** — `loadReviewState()` applies a read-time shim before returning:

```ts
const SEVERITY_COMPAT: Record<string, string> = {
  high: "P1", medium: "P2", low: "P3",
};
function migrateSeverity(s: string): string {
  return SEVERITY_COMPAT[s] ?? s;
}
```

Old data reads as P1/P2/P3. No write migration needed — the next save overwrites with the new scale.

**`parseFindingComment()`** (`improve/findings.ts`) — the badge regex `🔴|🟡|🟢|⚪` gains `🟠` for P1. Severity extraction maps emoji back to level:

```ts
const BADGE_TO_SEVERITY: Record<string, string> = {
  "🔴": "P0", "🟠": "P1", "🟡": "P2", "🟢": "P3",
};
```

**`INLINE_SEVERITY_RANK` / `INLINE_OVERFLOW_RANK`** (`review.ts`) — update to `{ P0: 4, P1: 3, P2: 2, P3: 1 }`.

**`reviewer-tuning.ts`** — any severity-keyed maps update to use P0-P3.

**`report.ts` `SEVERITY_EMOJI`** — update to match new map.

**Test fixtures** — `buildModelReview` in `testing.ts` and all inline references to `"high"|"medium"|"low"` severity strings update to `"P1"|"P2"|"P3"`. Add at least one P0 fixture.

### Files touched (PR 1)

| File | Change |
|------|--------|
| `src/review.ts` | `ModelReviewSchema` + `SEVERITY_LEVELS` + rank maps + `severityBadge()` |
| `src/review-state.ts` | `migrateSeverity()` shim in `loadReviewState()` |
| `src/report.ts` | `SEVERITY_EMOJI` |
| `src/reviewer-tuning.ts` | Severity rank maps |
| `src/improve/findings.ts` | `BADGE_PATTERN`, `BADGE_TO_SEVERITY` |
| `src/testing.ts` | `buildModelReview` fixtures |
| `src/*.test.ts` | All severity string literals |
| `skills/*.md` | Prompt guidance for all new fields + P0-P3 definitions |

---

## Deliverable 2: Deterministic Review Template

### Problem with the current body assembly

`buildReview()` assembles the body via `[...sections].filter(Boolean).join('\n\n')`. The section list and order are implicit in the array literal. Adding a section means knowing the right insertion index; machine parsing requires fragile regex on human-readable text.

### Solution: `formatReviewBody()`

A pure function extracted from `buildReview()`:

```ts
export function formatReviewBody(opts: FormatReviewBodyOptions): string
```

`FormatReviewBodyOptions` carries everything the current inline assembly uses: `commentPrefix`, `finalEvent`, `summary`, `approvalMessage`, `readiness`, `tier2Matches`, `skipped`, `errored`, `allSkillsCount`, `generalFindings`, `reviewComments`, `dropped`, `overflowCount`, `maxInlineComments`, `feedbackEnabled`, `survivingPrior`, `incrementalPass`, `priorSha`, `metadata`, `headSha`, `reviewCount`.

### Fixed section order

```
### {commentPrefix}
{readiness badge} **Readiness: N/5**
{summary | approvalMessage}

{tier2Notice}          ← only if tier2Matches.length > 0
{budgetNotice}         ← only if skipped.length > 0 or errored.length > 0

{findingsBlock}        ← only if general_findings.length > 0

Inline comments: {n}

{droppedNotice}        ← only if dropped.length > 0
{overflowNotice}       ← only if overflowCount > 0
{feedbackInvite}       ← only if feedbackEnabled && reviewComments.length > 0
{priorBlock}           ← only if survivingPrior.length > 0
{commandHints}         ← always
{reviewMarker}         ← always (moved into body from inline string)
<!-- ai-review metadata block -->   ← always
---
*Model: {model} · {n} agents · ${cost} · [ai-review-bot](...)*
```

`findingsBlock` is the existing `formatFindings()` output — no change to its rendering, just its position is now guaranteed.

### Why a pure function

- Independently unit-testable without running the full review pipeline.
- Downstream consumers (report, CLI, watch) can call it with the same options type rather than duplicating the assembly.
- Every integration test for the body can assert on the rendered string from `formatReviewBody()` rather than on the `buildReview()` return value, which runs LLM calls.

---

## Deliverable 3: Readiness Score

A deterministic integer 1–5. No LLM call. Pure function:

```ts
export function computeReadinessScore(opts: {
  finalEvent: ReviewDecision["event"];
  mergedReview: ModelReview;
  survivingPrior: PersistedFinding[];
  allAgentsSucceeded: boolean;
}): number
```

| Score | Condition (checked top-to-bottom, first match wins) |
|-------|------------------------------------------------------|
| 5 | `finalEvent === "APPROVE"` |
| 1 | Any P0 finding in `mergedReview.general_findings` or `mergedReview.inline_comments` |
| 2 | `survivingPrior.length > 0` (prior blockers still open) |
| 3 | `finalEvent === "REQUEST_CHANGES"` |
| 4 | `finalEvent === "COMMENT"` and `allAgentsSucceeded` |
| 3 | `finalEvent === "COMMENT"` and `!allAgentsSucceeded` (partial review) |

Rendered in the body as filled/empty squares:

```
🟩🟩🟩⬜⬜ **3/5**
```

Five squares, N filled with `🟩`, remainder `⬜`. The score is also written into the hidden metadata block (see Deliverable 5).

---

## Deliverable 4: GitHub Suggested-Change Blocks

Already partially complete — `suggestion` on `ModelInlineComment` renders as a ` ```suggestion ``` ` block via `buildCommentBody()`. No schema change needed.

What's missing is prompt discipline. Each skill file gains explicit rules:

> **When to emit a `suggestion`:**
> - The fix fits entirely on the commented line(s) (no new imports, no cross-file changes).
> - The change is mechanical — renaming, adding a null check, fixing a literal — not a design decision.
> - You are confident the suggested code is correct as written, not a sketch.
>
> **When NOT to emit a `suggestion`:**
> - The fix requires understanding broader context you don't have.
> - Multiple valid fixes exist — describe them in `body` instead.
> - The fix spans files or requires adding imports.

Multi-line suggestions already work via `start_line` — agents just need to know they can span a range. This is added to the skill prompt guidance.

---

## Deliverable 5: Review Counters, Last-Reviewed SHA, Command Hints, Hidden Metadata

### Review counter

`ReviewState` gains:

```ts
reviewCount: number  // incremented on every non-SKIP save; starts at 1
```

`loadReviewState()` defaults `reviewCount` to `0` on old records. `saveReviewState()` increments before writing. The counter appears in the footer as `Review #3 of this PR` and in the hidden metadata block.

### Last-reviewed SHA

Already tracked as the human-readable `reviewMarker` string. In the new template, `reviewMarker` moves into the hidden metadata block as `<!-- ai-review:sha=... -->`. The human-visible marker is replaced by `Review #{n} of this PR` in the footer, which is more useful to a developer than a raw SHA.

The idempotency check in `buildReview()` currently probes `body.includes(reviewMarker)`. After this change, it probes the hidden metadata block via `parseReviewMetadata()`.

### Hidden metadata block

A block of HTML comments embedded just before the cost footer, invisible in GitHub's rendered markdown:

```html
<!-- ai-review:sha=abc123def456 -->
<!-- ai-review:review=3 -->
<!-- ai-review:readiness=3 -->
<!-- ai-review:provider=anthropic -->
<!-- ai-review:model=claude-sonnet-5 -->
<!-- ai-review:findings=7 -->
<!-- ai-review:cost=0.000123 -->
```

Each line is a `<!-- ai-review:{key}={value} -->` pair. Values contain no spaces. The block is terminated by a blank line before the `---` footer separator.

**`parseReviewMetadata(body: string): ReviewMetaParsed | null`** — new pure function:

```ts
export interface ReviewMetaParsed {
  sha: string;
  review: number;
  readiness: number;
  provider: string;
  model: string;
  findings: number;
  cost: number;
}
```

Returns `null` when the block is absent (pre-Phase-1 reviews). Callers already handle `null` for missing SHA — this is a narrowing, not a new nullable surface.

All existing `body.includes("Reviewed commit:")` probes in `buildReview()` and `github-app.ts` switch to `parseReviewMetadata(body)?.sha`.

### Command hints

A static line appended before the metadata block, always present:

```
> Re-run: `/ai-review` · Full diff: `/ai-review --full` · Skip: `/ai-review --skip`
```

Rendered as a blockquote so it is visually de-emphasized but always discoverable.

### Files touched (PR 2)

| File | Change |
|------|--------|
| `src/review.ts` | `formatReviewBody()`, `computeReadinessScore()`, `parseReviewMetadata()`, `ReviewMetaParsed`, updated `buildReview()` |
| `src/review-state.ts` | `reviewCount` field on `ReviewState` |
| `src/github-app.ts` | SHA probe switches to `parseReviewMetadata()` |
| `src/report.ts` | Readiness score in report front-matter |
| `src/review.test.ts` | Tests for `formatReviewBody`, `computeReadinessScore`, `parseReviewMetadata` |

---

## Acceptance Criteria

### PR 1 — Schema + Severity

- [ ] `ModelReviewSchema` includes `category`, `confidence`, `evidence`, `suppressible` on all findings.
- [ ] `SEVERITY_LEVELS` is `["P0", "P1", "P2", "P3"]`. All downstream maps compile without `any` casts.
- [ ] `loadReviewState()` reads old `"high"|"medium"|"low"` values and returns them as `"P1"|"P2"|"P3"`.
- [ ] `parseFindingComment()` recognizes `🟠` and maps all four emoji back to P0-P3.
- [ ] All skill files define P0-P3 clearly and include guidance on `evidence`, `confidence`, `suppressible`, and suggestion discipline.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` all pass green.
- [ ] At least one test exercises a P0 finding end-to-end through `mergeReviews()` and `buildReviewComments()`.

### PR 2 — Template + Metadata

- [ ] `formatReviewBody()` is a pure function with unit tests covering: APPROVE, REQUEST_CHANGES with no prior, REQUEST_CHANGES with surviving prior, partial review (skipped agents), P0 present.
- [ ] `computeReadinessScore()` is a pure function with tests covering all six rows of the scoring table.
- [ ] `parseReviewMetadata()` roundtrips: `parseReviewMetadata(formatReviewBody({...}))` returns the values that were passed in.
- [ ] `buildReview()` uses `formatReviewBody()` exclusively — no residual inline string assembly.
- [ ] SHA idempotency check uses `parseReviewMetadata()`, not `body.includes("Reviewed commit:")`.
- [ ] `ReviewState.reviewCount` increments correctly across multiple saves; defaults to `0` on old records.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` all pass green.

---

## Open Questions

None blocking the implementation plan. Items to revisit during PR 2:

1. **Readiness score display** — five filled/empty squares may be too much visual weight for a clean APPROVE. Consider hiding the bar on score 5 and showing only `✅ Approved` instead.
2. **`confidence` in the body** — the schema captures confidence but the template spec does not render it. Decide during PR 2 whether confidence appears in inline comment bodies or only in the metadata block.
3. **`category` in `findingsBlock`** — the existing `| Sev | Finding |` table could gain a Category column. Deferred to PR 2 design review.
