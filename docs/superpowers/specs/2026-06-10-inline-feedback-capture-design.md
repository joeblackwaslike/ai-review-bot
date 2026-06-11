# Inline-Comment Feedback Capture — Design Spec

**Status:** Approved (brainstorming) — ready for implementation plan
**Date:** 2026-06-10
**Beads:** `ai-review-bot-qd6`
**Branch:** `feat/inline-feedback-capture` (off `main`)

## Goal

When the review bot leaves an inline comment on a PR, let the maintainer/developer
**👍 (valid, useful) or 👎 (wrong / intended-by-design / missing context)** that comment,
and **record the signal durably** so a later system can iteratively refine our review
skills. A 👍 means the problem we raised was real and helpful; a 👎 means something we
said was incorrect or not actually an issue.

**This spec is recording-only.** Building the analysis/refinement loop, dashboards, or
prompt auto-tuning is explicitly out of scope (see Non-Goals).

## Decisions (settled in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Capture mechanism | **Native emoji reaction** (👍/👎) on our inline comment, read by a **scheduled poll** | Lowest-friction UX; the pattern other bots use. GitHub does **not** emit webhooks for reactions, so polling the Reactions API is the only way to read them. |
| Storage | **Upstash / Vercel KV** | Native to the Vercel deployment, near-zero setup, durable, holds both the poll-set and the event log. Exportable when the refinement system is built. |
| Skill provenance | **Captured at post time** | The reaction poll only sees the comment, not which skill produced it. Provenance (which skill raised a 👎'd finding) is the core signal for refinement and **cannot be reconstructed later** — so we tag it when posting. |
| Poll trigger | **Vercel Cron (Pro)** at `*/10 * * * *` | Deployment is on Vercel Pro; native cron is the simplest trigger. (Hobby caps cron at once/day, which is too slow — not applicable here.) |
| Comment poll TTL | **14 days** | After 14 days we stop polling a comment (KV TTL + drop from poll-set). PRs are typically resolved well within this window. |
| Reactor filtering | **Record every reactor** (store login) | Don't pre-filter to maintainers; the refinement layer can filter by login/permission later. Per-reactor records also make re-polls idempotent and capture 👍→👎 changes and un-reacts. |
| Invitation | **One line in the review summary body** | Avoids noisy per-comment footers. |
| Scope | **Inline comments only**, **both bots** (Claude + Codex), **recording only** | Matches the stated ask. |

## Architecture

All changes bolt onto the **post** step of the existing review flow plus **one new cron
endpoint**. Review *generation* is unchanged. The system is provider-agnostic: each stored
record is tagged with the provider/installation that posted it, so the poller authenticates
with the correct GitHub App.

```text
Review posted (existing path)
  maybeSubmitReview() → POST /pulls/{n}/reviews  (inline comments)
    └─ NEW: list the review's created comments, zip each to its skill provenance,
       persist {comment_id → context} to KV, add to the poll-set.

Scheduled poll (NEW)
  Vercel Cron (*/10) → GET /api/cron/poll-feedback  (verifies CRON_SECRET)
    └─ poll.ts: listActiveComments(now) → group by installation → for each comment:
         GET /repos/{o}/{r}/pulls/comments/{id}/reactions   (REST — core bucket)
         diff vs last-seen reactions → append new/changed 👍/👎 to the events log
         markPolled(ref, lastSeen); then prune(now) drops comments past their TTL.
```

> **Rate-limit note:** the reaction reads use the REST **core** bucket (5,000/hr per
> installation token), separate from GraphQL, and run on the App installation token — they
> do **not** touch any user's personal `gh` quota.

## Components (each one responsibility, independently testable)

| File | Status | Responsibility / interface |
|---|---|---|
| `src/feedback/store.ts` | create | KV data model. Pure persistence — no GitHub/HTTP. Exports: `recordPostedComment(record)`, `listActiveComments(nowMs)`, `markPolled(ref, lastSeenReactions)`, `appendFeedbackEvent(event)`, `prune(nowMs)`. Takes a KV client via dependency injection so tests use an in-memory fake. |
| `src/feedback/reactions.ts` | create | Given an octokit + a stored comment record + its last-seen reaction state, fetch current reactions and compute the **new/changed verdict events** (pure diff logic over an injected client). Exports: `diffReactions(octokit, record, nowMs): Promise<{ events: FeedbackEvent[]; lastSeen }>` and a pure `computeReactionDelta(current, lastSeen)`. |
| `src/feedback/poll.ts` | create | Orchestrates one poll pass: `listActiveComments` → resolve octokit via the right App per `(provider, installationId)` → `diffReactions` → `appendFeedbackEvent` + `markPolled` → `prune`. Exports `runFeedbackPoll(deps)`. |
| `api/cron/poll-feedback.ts` | create | Thin HTTP handler. Verifies `CRON_SECRET` (Vercel Cron sends it as a header/secret), then calls `runFeedbackPoll`. Returns a small JSON summary `{polled, events, pruned}`. |
| `src/feedback/types.ts` | create | Shared types: `PostedCommentRecord`, `FeedbackEvent`, `Verdict = "up" \| "down"`. |
| `src/review.ts` | modify | Compute skill provenance in `buildReview` (no `mergeReviews` change): scan every successful agent's inline comments grouped by `path:line` → set of source skills; expose `commentProvenance` on `ReviewDecision`. Add `feedbackEnabled` to `ReviewContext` to gate provenance compute + the invitation line. |
| `src/github-app.ts` | modify | `postReviewWithRetry` returns the created review id. After a successful post, list the review's comments, map each to provenance, and `store.recordPostedComment(...)`. Gated by `FEEDBACK_ENABLED`; best-effort (KV failure never breaks the review). Passes `feedbackEnabled` into the `buildReview` context. |
| `src/config.ts` | modify | Parse `FEEDBACK_ENABLED` (default `false`), KV creds, `CRON_SECRET`. |
| `vercel.json` | modify/create | Add the `crons` entry. |

## Data model (Upstash KV)

- **Poll-set** — `fb:poll` : a **sorted set** of `ref` strings (`"{provider}:{commentId}"`),
  scored by `expiresAtMs`. The poll volume is low (only inline comments on currently-active
  PRs), so each pass polls **every still-active member**: active = `ZRANGEBYSCORE fb:poll {now} +inf`.
  Pruning expired members is `ZREMRANGEBYSCORE fb:poll -inf {now}` (plus deleting their
  `fb:cmt:*` keys, which also self-expire via TTL). `markPolled` updates only the comment
  record's `lastSeenReactions` — it does not change the score.
- **Comment context** — `fb:cmt:{provider}:{commentId}` : JSON
  ```jsonc
  {
    "commentId": 123456,
    "provider": "anthropic",        // or "openai"
    "installationId": 987,
    "owner": "joeblackwaslike",
    "repo": "ai-review-bot",
    "pr": 14,
    "headSha": "abc123",
    "path": "src/review.ts",
    "line": 42,
    "skills": ["silent-failure-hunter.md"],  // provenance (≥1)
    "title": "Possible null deref",          // inline comment title (inline comments carry no severity)
    "body": "…the inline comment text…",
    "postedAtMs": 1781070000000,
    "expiresAtMs": 1782279600000,   // postedAt + 14d
    "lastSeenReactions": { "octocat": "up" }  // login → latest verdict, for idempotent diffs
  }
  ```
  Set with a KV TTL of 14 days so the context self-expires.
- **Events log** — `fb:events` : append-only `LPUSH` of **denormalized** verdict records.
  This list is the dataset the future refinement system consumes.
  ```jsonc
  {
    "commentId": 123456,
    "provider": "anthropic",
    "owner": "joeblackwaslike", "repo": "ai-review-bot", "pr": 14,
    "path": "src/review.ts", "line": 42,
    "skills": ["silent-failure-hunter.md"], "title": "Possible null deref",
    "verdict": "down",
    "reactor": "octocat",
    "reactedAtMs": 1781071000000,    // reaction.created_at
    "capturedAtMs": 1781071800000    // when our poll observed it
  }
  ```

> Denormalizing `skills`/`path`/`title` onto each event means the events list is
> self-contained for analysis even after the `fb:cmt:*` context TTLs out.

## Provenance threading (detail)

1. In `buildReview` the agent outcomes are collected alongside their `skillPath` (the fan-out
   maps over `allSkills`). Build a `Map<"path:line", Set<skill>>` by scanning **every**
   successful agent's `inline_comments` — this preserves the full set of skills that flagged
   each location, independent of which comment body `mergeReviews` chose to display.
   `mergeReviews` is **not** modified.
2. Expose the result as `commentProvenance: Map<"path:line", { skills: string[]; title: string }>`
   on `ReviewDecision` (computed only when `context.feedbackEnabled`). `title` comes from the
   merged/displayed inline comment at that location.
3. After `POST /reviews` succeeds, fetch the created comments:
   `GET /repos/{o}/{r}/pulls/{n}/comments` and filter to `pull_request_review_id === review.id`.
   Match each returned comment to our intended one by `(path, line)` (body as a tiebreak),
   yielding `commentId → skills/severity/body`. Persist via `store.recordPostedComment`.

> The Reviews API response does not reliably enumerate per-comment IDs, hence the
> list-and-match step. Matching by `(path, line)` is unambiguous because diff-anchor
> validation already guarantees at most one of our comments per `path:line`.

## Verdict semantics

- Reaction `+1` → `up`; `-1` → `down`. Other reactions (`heart`, `rocket`, `laugh`,
  `confused`, `hooray`, `eyes`) are ignored for verdict purposes (not recorded as events).
- A reaction newly observed → append an event. A reactor changing `+1`→`-1` (or vice-versa)
  → append a new event with the new verdict (we keep the append-only history; `lastSeenReactions`
  prevents duplicate events for an unchanged reaction). A removed reaction → update
  `lastSeenReactions` (drop the login); no event is appended for removals in the MVP.
- Every reactor is recorded (login stored); no maintainer pre-filtering.

## UX: the invitation

Append one line to the review **summary** body (not per-comment):

> 💬 React 👍 / 👎 on any inline comment to tell us if it helped — it trains our reviewers.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `FEEDBACK_ENABLED` | `false` | Master switch. Off until KV is provisioned, so the feature is dark-launchable. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Upstash KV REST credentials. |
| `CRON_SECRET` | — | Shared secret the cron endpoint verifies (Vercel injects it for Cron requests). |

`vercel.json`:
```jsonc
{ "crons": [{ "path": "/api/cron/poll-feedback", "schedule": "*/10 * * * *" }] }
```

## Error handling

- **Recording is best-effort and must never break a review.** `recordPostedComment` is
  wrapped so a KV failure logs and is swallowed (the review POST has already succeeded) —
  consistent with the existing best-effort blocks in `maybeSubmitReview` (check-run,
  stale-thread resolution).
- **Cron poll is resilient per-comment:** a failure fetching one comment's reactions logs
  and continues to the next; one bad installation doesn't abort the pass.
- **Idempotency:** re-polling is safe — `lastSeenReactions` ensures an unchanged reaction
  never double-appends an event. Cron overruns/overlaps are safe for the same reason.
- **Auth:** if a comment's installation token can't be obtained (app uninstalled), drop the
  comment from the poll-set and continue.

## Testing

- `store.ts` — unit tests against an in-memory KV fake: record/list-due/append/prune/TTL.
- `reactions.ts` — `computeReactionDelta` pure-function tests: new 👍, new 👎, unchanged
  (no event), changed verdict (event), removed (no event, state updated), non-verdict
  reactions ignored.
- `poll.ts` — integration test with a mocked octokit (returns canned reactions) + KV fake:
  asserts events appended with correct denormalized fields and provenance, and that pruning
  removes expired comments.
- `mergeReviews` provenance — extend `review.test.ts`: two agents flag the same `path:line`
  → merged comment carries both skills.
- `github-app.ts` — extend `github-app.test.ts`: on a successful review with inline
  comments, `recordPostedComment` is called once per comment with the right provenance; with
  `FEEDBACK_ENABLED=false` it is **not** called; a KV throw does not fail the review.

## Non-Goals (explicitly deferred)

- The analysis/refinement loop (turning 👎 events into prompt/skill changes).
- Any dashboard, reporting, or aggregation UI.
- Reactions on the **summary** review (only inline comments are tracked).
- Capturing free-text reasons (reactions carry no text; a reply-based reason channel is a
  possible future addition).
- Maintainer/permission filtering at capture time (recorded data supports it later).

## Open follow-ups (not in this spec)

- Refinement system that consumes `fb:events` (separate spec).
- Optional reply-based reason capture (`pull_request_review_comment` webhook) to enrich a
  👎 with the maintainer's explanation.
- Optional pruning on PR close/merge (vs. TTL only).
