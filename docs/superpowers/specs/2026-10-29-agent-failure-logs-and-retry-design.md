# Agent outcome logs, failure classes and retry

Date: 2026-10-29
Beads: `ai-review-bot-w9b.9` (durable agent logs), `ai-review-bot-w9b.10` (classify failures, retry, per-agent baseline)
Epic: [review accuracy and convergence](2026-10-27-review-accuracy-epic-design.md)
Origin: [sprint 3 spec](2026-10-29-delta-scoping-warm-start-design.md), Known limits, and the user's follow-up questions on PR #89

## Problem

6 of the 14 Claude reviews on the 2026-10-25 incident PRs were partial. All six carry the "agents failed to complete" notice and none carry the "out of time budget" notice, so agents threw errors. Nobody can say why.

- `runAgent` returns a bare `{ status: "error" }` for any exception it does not recognize as a rate limit, a spent balance or a deadline abort (`src/review.ts`, catch block of `runAgent`). The error goes to `console.error` and is lost for any run that is not watched live.
- The review body names the failed agents and nothing else, so GitHub holds no record of the cause either.
- A failed agent is never run again in the same round, although the SDK error types separate failures a rerun can change from failures it cannot.
- The sprint 3 baseline advances to the new head even when agents failed, so a later delta round never shows the failed agents the earlier code. 6 of 14 incident reviews were in that state.
- Tokens spent on a failed attempt are billed but not counted in the review's cost.

## Goals

1. Every agent outcome, ok or not, produces a structured record that survives the run, locally and on the hosted deployment.
2. A failed agent carries a failure class and a retryable flag, set by a pure function over the thrown error.
3. A retryable failure is retried once in the same round when the time budget allows. A failure a rerun cannot change is reported separately and not retried.
4. An agent that did not complete is not treated as having reviewed the baseline: the next round runs it over the whole PR instead of the delta.
5. Tokens from failed attempts are counted in the cost.

## Non-goals

- Fixing any particular cause. Raising the output cap, lowering reasoning effort, loosening the schema or capping findings per agent all wait for the data this change produces. The cap is `max(4096 * 8, 16000)` tokens, thinking included (`outputBudget` in `src/router.ts`).
- Changing how rate limits, quota exhaustion and deadline aborts are handled. They keep their current statuses.
- A log reader, aggregator or dashboard. The records are readable with `gh api` and `jq` or by opening the file.
- Retrying more than once, or retrying across rounds.

## Decisions

### The record

One record per agent attempt:

| Field | Meaning |
| --- | --- |
| `skill` | skill file name without the directory, e.g. `security-sast.md`. Must be one of the known skill names, otherwise the record is dropped from the marker. |
| `attempt` | 1, or 2 for the retry |
| `status` | `ok`, `error`, `rate_limited`, `quota_exhausted` or `skipped` |
| `class` | failure class, only when `status` is `error` |
| `retryable` | boolean, only when `status` is `error` |
| `httpStatus` | number, when the error carries one |
| `finishReason` | the SDK's finish reason, when the error carries one |
| `errorName` | one of `AI_NoObjectGeneratedError`, `AI_APICallError`, `AI_RetryError`, `Error` or `other`. The SDK sets these `name` values on its errors, which differ from the constructor names. |
| `durationMs`, `inputTokens`, `outputTokens` | for `ok` and for errors that carry usage. The SDK calls them `inputTokens` and `outputTokens`; the record uses the same names, and the review's totals keep their existing `promptTokens` and `completionTokens`. |

The record holds no model output and no free-text error message, and no field copies the SDK error's `text`, `response`, `cause` or body. Review bodies are public on public repositories, and a provider error body or partial model text can quote the diff. The local file adds one more field, `message`, the error message cut to 300 characters, because that file never leaves the machine.

### Where it is kept

- **Review body.** A hidden metadata comment `<!-- ai-review:agents=<json> -->` in the existing marker block, holding the records of the final attempt per agent plus any first attempt that was retried. Every field is an enum from a closed list, a boolean or a number, so no value can contain `-->`; the writer still escapes `<`, `>` and `-->` defensively. It is written on every posted review, approvals included, and holds a separate `pending` list of skill names (see Per-agent baseline). Past 4 KB the writer drops detail from `ok` records and from first attempts that were retried, never from the `pending` list and never from a non-`ok` record, so the set of skills that owe coverage is always complete. At most 20 records fit; a longer list is cut from the `ok` records first. It is the durable copy for the hosted deployment, where the function's file system does not persist and Vercel logs are short lived, and it is readable later with `gh api`.
- **Reading it back.** A review body can quote another review, and model-written summary text precedes the markers. The formatter writes the markers as one block, then a blank line, then the `---` footer and the model and cost line. A new `readMetadataBlock(body)` returns the `key=value` pairs from that block only: lines that start at column 0 with `<!-- ai-review:`, just above the footer, with a duplicated key rejected. Every consumer uses it: the existing `parseReviewMetadata`, the sha and count read in `deriveBaseline`, the `alreadyReviewed` check, and the new `agents` parser. A body with no such block is a legacy body, and for it each consumer falls back to today's whole-body search, so old reviews keep working. The `agents` parser validates every record against the closed lists and treats anything that fails as "no information", never as an error. Selecting the baseline source by review author, instead of by body content, is a separate existing gap and is not part of this change.
- **Console.** One `console.log("agent outcome", record)` per record, with the error `message` cut to 300 characters added (hosted debugging needs it, and Vercel logs are private to the deployer; the review body never carries it), replacing the scattered per-status lines that carry less detail. The records are logged straight after the agent passes finish, before any early return or throw, so a run in which every agent failed still leaves them.
- **Local file.** `.ai-review/logs/agents.jsonl`, one JSON object per line: the record, plus `ts`, `owner`, `repo`, `pr`, `sha`, `provider`, `model` and `message`. It is written only when the CLI turns it on (`watch`, `review`, `audit`). The webhook paths never turn it on, so the hosted deployment makes no file writes. The directory is already gitignored. A write failure is logged and never fails a review.
- **What is not durable on GitHub.** A round that posts no review (every agent rate limited or out of quota, every agent failed so the build throws, a silent round) leaves its records only in the console and, locally, the file. The hosted deployment keeps those in Vercel's short-lived logs. Posting a diagnostic comment for such rounds is out of scope.

### Failure classes

`classifyAgentError(err)` is pure and lives in a new `src/agent-failure.ts`. It returns `{ class, retryable, httpStatus?, finishReason?, errorName }`. It reads the SDK error types by their `isInstance` helpers and `name` values, not by constructor name, and it unwraps first.

Unwrapping. A `RetryError` (`AI_RetryError`) keeps its cause in `lastError` and `errors`, not in `cause`. The classifier unwraps `RetryError.lastError`, then follows `cause` up to three levels, and classifies the innermost error it recognizes.

Precedence, first match wins:

| Order | Class | When | Retryable |
| --- | --- | --- | --- |
| 1 | `content_refused` | `finishReason` is `content-filter` on any recognized error | no |
| 2 | `output_truncated` | `NoObjectGeneratedError` with `finishReason` `length` | no. The same cap and prompt are likely to hit it again. |
| 3 | `no_output` | `NoObjectGeneratedError` where the model returned no text | yes. Sampled, so a second attempt can differ. |
| 4 | `schema_mismatch` | any other `NoObjectGeneratedError`: the text did not parse or did not match `ModelReviewSchema` | yes. The output is sampled. |
| 5 | `auth` | `APICallError` with status 401 or 403 | no |
| 6 | `transient_http` | `APICallError` with status 408, 409 or 500 and above, including 529 overloaded, after the SDK's own retries | yes. The retry pass runs after the whole first pass, which gives the provider time. |
| 7 | `invalid_request` | `APICallError` with any other 4xx status except 429 | no. The same request is rejected the same way. |
| 8 | `network` | no HTTP status, and the error or its cause carries a Node system code in a fixed list (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `EPIPE`, or an `UND_ERR_` socket or connect code) | yes |
| 9 | `unknown` | anything else, including a plain `TypeError` | no. It may be a programming error, which a rerun repeats. |

Rate limits (429), spent balances and our own deadline aborts keep the statuses they already have and are not classified here. A generic provider "refusal" with no `content-filter` finish reason has no dedicated field in the SDK error types and lands in `unknown` until logs show how providers report it.

### Retry

- After the first pass, collect the agents whose outcome is `error` with `retryable: true`.
- Eligibility is checked twice. It is checked when the retries are collected, and again immediately before each retry is dispatched, after any pacing delay, because pacing can use up the time that made the retry eligible. A retry starts only if the time left before the agent deadline is at least `max(30 s, that agent's first attempt duration)`. Otherwise it is recorded as `retry skipped: out of time`.
- The retry's abort timeout is built from the original absolute deadline, as for the first pass.
- The retry pass keeps `lastRateLimit` from the first pass and paces its first agent too, since the first pass already learned the provider's pressure. It does not run its first agent alone: one serial warm-up covers one shared prefix, a transport failure proves nothing about the cache, and recovery rounds can have two prefixes. The accepted cost is some concurrent cold cache writes on a retry. It is bounded by the number of retried agents and is not measured.
- At most one retry per agent. A successful retry replaces the failure. A failed retry keeps the second attempt's class.
- An agent that succeeds on the retry merges its findings with the rest like any other.

### Reporting

The partial-review notice stops being one list of names. It groups by outcome:

- "failed, then recovered on retry" (informational, one line, no warning),
- "failed after retry" with each agent's class,
- "failed, not retried" with each agent's class and the reason (`output_truncated`, `invalid_request` and so on),
- "retry skipped, out of time" and the existing "did not run, out of time" line.

The class names in the notice are the enum values, so a reader can search for them.

### Per-agent baseline

The unit is pending coverage, a set of skills that owe the PR a full review. It is independent of which agents a round happens to select.

- **Entering.** After any round's agent passes, a skill is added to pending if it ran (or was due to run) and ended in any status other than `ok`: `error` after retry, `skipped`, `rate_limited` or `quota_exhausted`. A skill that was not selected this round, for example a Tier 2 skill the delta did not trigger, is left as it was.
- **Where it is stored.** In the `agents` marker (every skill whose last record is not `ok`, plus every skill carried as pending), and in `ReviewState.incompleteSkills` when KV is used. `deriveBaseline` returns it as `incompleteSkills`. A review with no marker means an empty set, which is the sprint 3 behavior.
- **Scheduling.** On any round with a baseline, every pending skill that still exists is scheduled, whether or not this round's detection would have selected it. Pending skills are queued ahead of the others, so the agent deadline cuts the skills that owe nothing first. A pending Tier 2 skill is not scheduled while Tier 2 is switched off (`REVIEW_TIER2_ENABLED=false`); it stays in the pending list. A pending Tier 2 skill therefore runs again even when the delta would not trigger it. A pending skill whose file no longer exists is dropped.
- **Input.** A pending skill is given the PR's own files and patches, the same input a FULL round uses. Every other agent keeps the delta. The shared user message therefore exists in two versions, and the second costs one more prompt-cache write for the pending skills.
- **Triage SKIP.** If triage says SKIP and pending is not empty, the round does not return early. It runs only the pending skills over the whole PR and nothing else.
- **Clearing.** A pending skill is cleared only when it completes `ok` with complete whole-PR input, in a FULL round (forced or not) or in the pending-skill input above. Complete means every PR file has a patch and none was cut by the per-file size limit in `trimPatch` (`src/prompt.ts`). A skill that completes `ok` on a delta only, or on whole-PR input that was cut or lacked patches, is not cleared; its findings still merge. On a PR too large for complete input the skill therefore stays pending. Three refinements keep that from being permanent for ordinary reasons:

- A file with no `patch` counts as complete when it has zero additions and deletions (a binary file, a pure rename, a mode change), because there is nothing a reviewer could read. A file with changes but no `patch` (GitHub omits the patch for very large diffs) is incomplete.
- Generated and lock files (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `Cargo.lock`, `poetry.lock`, `go.sum`, `*.min.js`, `*.snap`) are left out of the completeness check, because the reviewers are not expected to read them and a single lockfile diff over the size limit would otherwise keep every pending skill pending for the life of the PR.
- Completeness also requires that the PR file list is whole: it is incomplete when the list is shorter than the PR's reported `changed_files` or has reached GitHub's 3000-file listing cap.
- **No silent recovery.** A round that clears a pending skill always posts a review, even when it would otherwise be silent, so that the new `agents` marker on GitHub no longer lists the skill. With KV the state is also updated, but GitHub is the record when KV is absent. If the round fails to clear a skill, it stays pending and the marker says so.
- **Anchors.** Inline comments are validated against the PR's own patches, not the delta, so findings a pending skill raises outside the delta can still be anchored.

This replaces the sprint 3 ruling that a partial prior review still counts as the whole baseline. The baseline sha still moves to the new head, since the agents that did complete did review the earlier code; only the pending skills are pointed back at it.

### Cost

An `error` outcome that carries `usage` (the SDK attaches it to `NoObjectGeneratedError`) adds its tokens to the review's totals, mapped from `inputTokens` and `outputTokens`. A retry is billed like any other attempt. A deadline abort carries no usage and adds none. `audit.ts` has its own aggregation loop that counts usage only for `ok`; it is changed the same way. The footer cost therefore rises on rounds with failures, which is accurate.

## Design

| File | Change |
| --- | --- |
| `src/agent-failure.ts` (new) | `FailureClass`, `AgentFailure`, `classifyAgentError`. |
| `src/review-metadata.ts` (new) | `readMetadataBlock(body)`; used by `parseReviewMetadata`, `deriveBaseline` and the `alreadyReviewed` check. |
| `src/agent-log.ts` (new) | `AgentRecord`, `toRecord(...)`, `formatAgentsMarker(records)`, `parseAgentsMarker(body)`, `logAgentRecords(records, ctx)`, `enableAgentLogFile(path)`. |
| `src/review.ts` | `AgentOutcome` error variant carries `failure` and `usage`; `runAgent` classifies; the agent pass becomes first pass plus retry pass; notice grouping; marker in `formatReviewBody`; `incompleteSkills` use in the incremental user message; cost from failed attempts. |
| `src/baseline.ts`, `src/review-state.ts` | `incompleteSkills` on the derived baseline and on `ReviewState`. |
| `src/audit.ts` | Uses the record helper for its own `runAgent` calls and counts usage from failed attempts. |
| `src/cli.ts` | Turns the local file on for `watch`, `review` and `audit`. |

## Tests (each written to fail first)

- `classifyAgentError`: built from the real SDK error classes (`NoObjectGeneratedError`, `APICallError`, `RetryError` wrapping them, and `TypeError('fetch failed')` with and without a system-code cause), one case per class, the precedence overlaps (`content-filter` on a `NoObjectGeneratedError`, a 429-adjacent 4xx, 408 and 409), a `RetryError` wrapping each recognized error, and a plain `TypeError` giving `unknown`. A fake object with the right field names is not enough, because the field names are the risk.
- Record and marker: round trip through `formatAgentsMarker` and `parseAgentsMarker`; an unknown skill or error name is dropped; an oversized list keeps every non-`ok` record and the whole `pending` list while `ok` records are dropped; a quoted marker (prefixed with `> `), a duplicated key and a marker in the middle of the summary text are all ignored by every consumer, including the sha and count in `deriveBaseline` and the `alreadyReviewed` check, and a legacy body with no block still parses as before; no model text, `text`, `response` or `cause` content is present even when the thrown error carries them.
- Retry: a retryable failure then success yields the findings and a recovered note; a non-retryable failure is not run twice (the model stub is asserted to be called once for it); a retryable failure with too little time left is not retried and says so; a pacing delay that crosses the eligibility threshold cancels the retry; two failures in a row keep the second class; usage from every attempt is summed into the cost; every agent failing still logs its records before the build throws; all rate limited and all quota exhausted rounds log their records.
- Notice: each group renders with the class names; an all-ok round has no notice.
- Pending coverage: an `agents` marker with one failed skill gives `incompleteSkills`; an incremental round gives that skill the PR's files and the others the delta (assert the two user messages); a KV state round trips the list; a triage SKIP with a pending skill runs only that skill; a pending Tier 2 skill runs although the delta would not select it; a skill whose file is gone is dropped; a skill that completes only on a delta stays pending; a skill that completes on whole-PR input with a trimmed patch or a missing patch stays pending; a round that clears a skill posts although nothing else is new, and its marker no longer lists the skill, with and without KV; a forced FULL round clears by success; a recovery finding outside the delta keeps its inline anchor.
- Audit: usage from failed attempts is counted.
- Local file: written when enabled, not written when not, a write failure does not fail the review.
- The real-GitHub check from sprint 3 is rerun after the change: `deriveBaseline` on the three incident PRs still derives the same baselines, and an old body with no `agents` marker gives an empty `incompleteSkills`.

## Known limits

- A skill that cannot finish on whole-PR input inside the deadline (it timed out on the full PR once and times out again) stays pending, and every later non-skipped round posts a partial review for it, so the bot does not reach APPROVE on that PR. This is the same limit a FULL round already has. After the logs show how often it happens, a rule that gives up on a skill after repeated whole-PR failures is the follow-up; none is built here.
- On a round where any agent saw the whole PR, inline comments from every agent anchor against the PR's patches, so a delta agent's comment outside the delta can post.
- A pending-only round that posts still carries the delta wording in its footer.

- The class table was written from the SDK documentation and not from observed failures. The first real logs may show a class that belongs in `unknown`, or an `unknown` that deserves a class. The classifier is data, so it is cheap to change.
- `schema_mismatch` is retried once. If the cause is a schema the model cannot satisfy, the retry fails the same way and costs one more attempt per affected agent per round.
- The agents marker is bounded at 20 records and 4 KB. A typical 8-agent round with one retry is a few hundred bytes.
- Cache cost of the two user-message versions and of concurrent retry writes is not measured.
- Reviews posted before this change have no `agents` marker. They are read as having no incomplete agents, which is the sprint 3 behavior.
- The local file has no rotation.
