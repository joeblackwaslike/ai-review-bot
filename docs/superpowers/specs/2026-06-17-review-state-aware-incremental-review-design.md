# Review-State-Aware Incremental Review

**Status:** Design approved (2026-06-17), pending spec review
**Tracking epic:** `ai-review-bot-9nv` (will be reframed as the epic)
**Ships as:** two stacked PRs under one epic

## Problem

The Claude/Codex review bots have two coupled defects, both traced to code:

1. **Stuck-loop — mechanically unable to approve a correct PR.** Each re-review round re-derives the *same* findings (often already fixed or already justified), returns `REQUEST_CHANGES`, and the PR can never reach `APPROVE` through normal iteration. Observed on PR #18 and #19; both required a maintainer dismiss+merge.

   Root cause (verified):
   - The finding-producing agents receive only the *current full diff* + *other bots'* reviews. The bot's own prior review (`priorOwnReview`) is fetched but passed **only to `generateSummary`** (the prose body), never to the agents (`src/review.ts:692-703`, `src/prompt.ts:54-87`). So every round each agent re-derives blind to what it already raised and to maintainer reply-thread justifications.
   - `.some()` event aggregation (`src/review.ts:314`): any one of 7–8 blind agents re-flagging a stale finding sets the whole event to `REQUEST_CHANGES`.
   - Per-file `trimPatch` 8000-char cap (`src/prompt.ts:34`) hard-truncates large patches → fixes beyond 8000 chars are invisible → re-flagged.

   Diagnostic signature: the prose body is reliably accurate (it has `priorOwnReview`) while the findings table + event recycle false-positives. #19 (multi-commit, justification-dependent fixes) got stuck; #20 (single self-evident commit) passed.

2. **Expensive full re-review on every push, even unrelated ones.** Every `pull_request.synchronize` mints a new per-commit idempotency claim (`...@{headSha}`, `src/github-app.ts:283`) and re-runs all 5–8 agents on the **full cumulative PR diff** (`src/review.ts:665`). Nothing checks whether the push touches *this bot's* findings or is "for it." A trivial unrelated one-liner triggers a full, expensive re-review. In a multi-bot PR (the bot is usually behind 3–4 others), each round of fixing another bot's feedback re-triggers our full review with no added value.

A third, related defect drives the operational pain:

3. **In-process delay burns the 800s budget.** `vercel.json` sets `maxDuration: 800`. The review delay is an in-process `setTimeout` that holds the function open doing nothing; on an 8-agent PR, `~450s sleep + ~360s agents > 800s` → Vercel **hard-kills** the invocation mid-review → the auto-resync never posts and incurred agent cost is wasted.

## Goals

- A correct PR can reach `APPROVE` through normal iteration — no dismiss+merge crutch.
- A push that doesn't concern this bot does **not** trigger an expensive re-review.
- Re-reviews are **incremental** (scoped to the delta since the bot's own last review) and **resolution-aware**.
- The review delay no longer consumes the function's execution budget; large PRs never get killed mid-review.
- Never *worse* than today on any failure path (KV cold, triage error, etc.).

## Non-Goals

- Changing the skill frameworks or the `submit_review` tool schema.
- Cross-provider review coordination beyond "is this push for me" (no shared state between the Claude and Codex bots).
- Reworking the local `ai-review audit` CLI path.

## Approach (chosen)

A **cheap triage gate** in front of the expensive agent fan-out, backed by **persisted per-bot review state**, with a **QStash-based scheduler** replacing the in-process sleep. Shipped as two stacked PRs so the highest-value fix (triage gate) lands first without new infra.

Alternatives considered and rejected:
- *Always-incremental, no triage* — still fans out all agents on every push; doesn't answer "is this for me?".
- *Full review, suppress resolved findings* — fixes the stuck-loop but not the expensive-re-review cost.
- *Vercel Cron + KV schedule* (vs QStash) — up-to-2-min jitter, cron-frequency plan limits, poll overhead. QStash gives precise delays, content dedup (coalescing), and no polling; we're already on Upstash.

## Shared foundation — per-bot review state in KV

Key: `review-state:{provider}:{owner}/{repo}#{pr}`

```jsonc
{
  "lastReviewedSha": "abc123...",
  "event": "REQUEST_CHANGES",          // COMMENT | REQUEST_CHANGES | APPROVE
  "findings": [
    { "id": "sha1-0", "path": "src/x.ts", "line": 42,
      "title": "Unvalidated input", "severity": "high",
      "status": "open" }               // open | resolved
  ],
  "reviewedAt": "2026-06-17T00:00:00Z"
}
```

- Written on every posted review (and on a SKIP that changes finding status). Long TTL (e.g. 30 days), refreshed on each write.
- **Cold-KV fallback:** if no state, re-parse the bot's last GitHub review (`priorOwnReview`) into a best-effort findings list; if even that is absent → treat as first review (`FULL`). Reuses the existing KV client (`src/feedback/kv.js`); same graceful-degradation contract as the idempotency claim (KV absent ⇒ behave like today).

## PR 1 — review-state + triage gate

Fixes the stuck-loop **and** the expensive-re-review cost. No new vendor.

### Decision flow (inside `buildReview`)

1. Load review state (KV → GitHub re-parse → cold).
2. **No prior review** → `FULL` fan-out (current behavior) → persist state.
3. **Prior review exists:**
   a. Fetch the delta diff: `GET /repos/{owner}/{repo}/compare/{lastReviewedSha}...{headSha}`.
   b. **Triage:** one cheap model call (Haiku tier) over *my open findings + the delta diff*, forced to a structured tool returning:
      ```jsonc
      { "resolved": ["sha1-0"], "newRisk": false,
        "recommendation": "SKIP" }      // SKIP | INCREMENTAL | FULL
      ```
   c. Act on the recommendation:
      - **SKIP** → mark `resolved` findings; recompute event (all resolved & none open ⇒ `APPROVE`); **post nothing new**; persist updated state. (Handles the unrelated-one-liner and another-bot's-fix cases.)
      - **INCREMENTAL** → run the agent fan-out with the **delta** as the diff payload + prior open findings injected as context ("verify whether these are resolved; re-raise only if still present"). Merge = new findings ∪ still-open prior − resolved. Persist + post.
      - **FULL** → full-diff fan-out (structural change, or triage low-confidence). Persist + post.

### Stuck-loop fixes (baked in regardless of triage path)

- Inject `priorOwnReview` + resolved-thread state into the **agent** prompt (`buildUserMessage`), closing the `src/prompt.ts` gap. Instruction: "You previously raised the findings below. Do NOT re-report one the current diff or a maintainer reply already addresses; only escalate if still unresolved."
- Merge step diffs new findings against prior findings and **drops resolved** ones.
- **Event = `REQUEST_CHANGES` only if unresolved findings remain.** Relax the `.some()` at `src/review.ts:314` so a lone re-raise of an already-addressed finding does not hard-block.
- Bump the `trimPatch` cap (e.g. 8000 → 24000) — incremental deltas are small anyway, so truncation rarely bites.

### Tier 2 safety interlock (temporary)

PR 1's first full review of a large PR still runs under the existing in-process sleep, so an 8-agent pass can still exceed 800s. To stay under budget until PR 2 removes the sleep:

- Add a `TIER2_ENABLED` constant gating `detectTier2Skills` in `src/review.ts`, overridable by env `REVIEW_TIER2_ENABLED`.
- **PR 1 sets it OFF** → max 5 (Tier 1) agents → every path fits the budget even with the in-process delay.
- **PR 2 sets it ON** (default true) once QStash frees the full 800s for agents.
- Explicit, short-lived tradeoff: type-design / comment-analyzer / security-auditor / architect-review skills pause between the two merges.

## PR 2 — QStash scheduler

Kills the in-process sleep + 800s-kill risk, adds push coalescing, re-enables Tier 2.

- Webhook handler **publishes a QStash message** instead of sleeping: `delay` = initial/resync seconds, target `/api/review/run`, `deduplicationId = {provider}:{pr}` so a new push **replaces** the pending message (coalescing → only the final head is reviewed). Returns 200 immediately.
- New endpoint **`/api/review/run`**: verifies the QStash signature, then calls `maybeSubmitReview` (→ triage). Runs **fresh with the full 800s budget** — no sleep consumed.
- The `issue_comment /ai-review` path still runs directly (no delay), as today.
- Flip `REVIEW_TIER2_ENABLED` default to true.
- Config: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` (add to `.env.example` + `src/config.ts`).

## Error handling (fail toward reviewing, never toward silent skip)

- **KV absent / cold** → `FULL` (current behavior). Never worse than today.
- **Triage call errors or low confidence** → fall back to `INCREMENTAL` (or `FULL` if no usable delta). A `SKIP` requires a confident triage result; an error must never cause a silent skip.
- **QStash bad signature** → 401. **Delivery failure** → QStash built-in retries.
- Keep the per-`(pr, headSha)` idempotency claim so duplicate QStash deliveries don't double-review.

## Testing

PR 1:
- Triage decode: `SKIP` / `INCREMENTAL` / `FULL` parsing; resolved-id → finding-status mapping.
- Cold-KV fallback → `FULL`; **triage-error → review (not skip)**.
- State store: round-trip, TTL refresh, GitHub re-parse fallback.
- Merge: resolved findings drop; event clears when all resolved; **a lone re-raise of an addressed finding does not block**.
- Tier 2 interlock: `REVIEW_TIER2_ENABLED=false` ⇒ exactly 5 agents; `true` ⇒ Tier 2 detectors run.
- **End-to-end multi-bot scenario:** review@sha1 → push sha2 (another bot's fix, my findings untouched) → `SKIP` → push sha3 (resolves my findings) → `INCREMENTAL` → `APPROVE`.

PR 2:
- Webhook publishes with correct delay + `deduplicationId`; a second push replaces the pending message.
- `/api/review/run` verifies signature (rejects bad), runs review on valid.
- No-more-sleep: the webhook path no longer calls the in-process `setTimeout`.

## Files (indicative)

PR 1:
- `src/review-state.ts` (new): KV state load/save, GitHub re-parse fallback, finding id/serialization.
- `src/triage.ts` (new): delta fetch + cheap triage call + structured decode.
- `src/review.ts`: wire triage gate into `buildReview`; merge drops-resolved; event aggregation; `TIER2_ENABLED` gate.
- `src/prompt.ts`: inject `priorOwnReview` + resolved threads into `buildUserMessage`; raise `trimPatch` cap.
- `src/config.ts`: `REVIEW_TIER2_ENABLED`.
- Tests colocated (`*.test.ts`).

PR 2:
- `api/review/run.ts` (new): QStash-verified run endpoint.
- `src/scheduler.ts` (new): QStash publish/replace helper.
- `src/github-app.ts`: replace in-process sleep with `scheduler.publish`.
- `src/config.ts`: QStash keys; flip `REVIEW_TIER2_ENABLED` default.
- `.env.example`, `vercel.json` if needed.

## Open questions (for spec review)

- **SKIP visibility:** post truly nothing (chosen default) vs. silently update the prior review's "Reviewed commit" marker so GitHub shows it as current. Leaning: nothing, to honor "don't add noise."
- **Resolved-thread source:** GraphQL `reviewThreads(isResolved)` adds a call per re-review; acceptable, or derive resolution from triage alone in v1?
