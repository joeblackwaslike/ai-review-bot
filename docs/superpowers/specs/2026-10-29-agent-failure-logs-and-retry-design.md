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
| `skill` | skill file name without the directory, e.g. `security-sast.md` |
| `attempt` | 1, or 2 for the retry |
| `status` | `ok`, `error`, `rate_limited`, `quota_exhausted` or `skipped` |
| `class` | failure class, only when `status` is `error` |
| `retryable` | boolean, only when `status` is `error` |
| `httpStatus` | number, when the error carries one |
| `finishReason` | the SDK's finish reason, when the error carries one |
| `errorName` | the error's constructor name |
| `durationMs`, `promptTokens`, `completionTokens` | for `ok` and for errors that carry usage |

The record holds no model output and no free-text error message. Review bodies are public on public repositories, and a provider error body or partial model text can quote the diff. The local file adds one more field, `message`, the error message cut to 300 characters, because that file never leaves the machine.

### Where it is kept

- **Review body.** A hidden metadata comment `<!-- ai-review:agents=<json> -->` next to the existing markers, holding the records of the final attempt per agent plus any first attempt that was retried. It is built only from enums and numbers, so it cannot contain `-->`. It is written on every posted review, approvals included. This is the durable copy for the hosted deployment, where the function's file system does not persist and Vercel logs are short lived, and it is readable later with `gh api`.
- **Console.** One `console.log("agent outcome", record)` per record, replacing the scattered per-status lines that carry less detail.
- **Local file.** `.ai-review/logs/agents.jsonl`, one JSON object per line: the record, plus `ts`, `owner`, `repo`, `pr`, `sha`, `provider`, `model` and `message`. It is written only when the CLI turns it on (`watch`, `review`, `audit`). The webhook paths never turn it on, so the hosted deployment makes no file writes. The directory is already gitignored. A write failure is logged and never fails a review.

### Failure classes

`classifyAgentError(err)` is pure and lives in a new `src/agent-failure.ts`. It returns `{ class, retryable, httpStatus?, finishReason?, errorName }`. The classes and the rule for each follow what the AI SDK exposes, and the plan's first step is to confirm the field names against the installed package types and docs, because the classifier depends on them.

| Class | When | Retryable |
| --- | --- | --- |
| `schema_mismatch` | `NoObjectGeneratedError` whose `finishReason` is not `length`: the output did not parse or did not match `ModelReviewSchema` | yes. The output is sampled, so a second attempt can pass. |
| `output_truncated` | `NoObjectGeneratedError` with `finishReason` `length`: the output hit the cap | no. A second attempt with the same cap and prompt is likely to hit it again. |
| `server_error` | `APICallError` with status 500 or above, including 529 overloaded, after the SDK's own retries | yes. The retry pass runs after the whole first pass, which gives the provider time. |
| `network` | a transport failure with no HTTP status (connection reset, DNS, timeout that is not our own deadline) | yes |
| `invalid_request` | `APICallError` with a 4xx status other than 401, 403, 408, 409 and 429 | no. The same request is rejected the same way. |
| `auth` | 401 or 403 | no |
| `content_refused` | `finishReason` `content-filter`, or a provider refusal | no |
| `unknown` | anything else | no. It may be a programming error, which a rerun repeats. |

Rate limits (429), spent balances and our own deadline aborts keep the statuses they already have and are not classified here.

### Retry

- After the first pass, collect the agents whose outcome is `error` with `retryable: true`.
- A retry starts only if the time left before the agent deadline is at least `max(30 s, that agent's first attempt duration)`. Otherwise it is recorded as `retry skipped: out of time`.
- Retries run with the same concurrency, the same abort signal and the same deadline as the first pass. The first agent is not run alone this time, because the prompt cache is already written.
- At most one retry per agent. A successful retry replaces the failure. A failed retry keeps the second attempt's class.
- Nothing else changes for an agent that succeeded on the retry; its findings merge with the rest.

### Reporting

The partial-review notice stops being one list of names. It groups by outcome:

- "failed, then recovered on retry" (informational, one line, no warning),
- "failed after retry" with each agent's class,
- "failed, not retried" with each agent's class and the reason (`output_truncated`, `invalid_request` and so on),
- "retry skipped, out of time" and the existing "did not run, out of time" line.

The class names in the notice are the enum values, so a reader can search for them.

### Per-agent baseline

The `agents` marker names every agent that did not complete in the review (status other than `ok`, after any retry). When a later round resolves a baseline from GitHub, `deriveBaseline` returns those skill names as `incompleteSkills`. When the baseline came from KV, `ReviewState` carries the same list, saved when the state is written.

On an INCREMENTAL round, each agent in `incompleteSkills` is given the PR's own files and patches, the same input a FULL round uses, instead of the delta. Every other agent keeps the delta. The shared user message therefore exists in two versions, and the second costs one more prompt-cache write for the incomplete agents. When the round completes those agents, the next review's marker lists none. A FULL round needs no change, because it already gives every agent the whole PR.

This replaces the sprint 3 ruling that a partial prior review still counts as the whole baseline. The baseline sha still moves to the new head, since the agents that did complete did review the earlier code; only the agents that did not are re-pointed at it.

### Cost

An `error` outcome that carries `usage` (the SDK attaches it to `NoObjectGeneratedError`) adds its tokens to the review's totals. A retry is billed like any other attempt. The footer cost therefore rises on rounds with failures, which is accurate.

## Design

| File | Change |
| --- | --- |
| `src/agent-failure.ts` (new) | `FailureClass`, `AgentFailure`, `classifyAgentError`. |
| `src/agent-log.ts` (new) | `AgentRecord`, `toRecord(...)`, `formatAgentsMarker(records)`, `parseAgentsMarker(body)`, `logAgentRecords(records, ctx)`, `enableAgentLogFile(path)`. |
| `src/review.ts` | `AgentOutcome` error variant carries `failure` and `usage`; `runAgent` classifies; the agent pass becomes first pass plus retry pass; notice grouping; marker in `formatReviewBody`; `incompleteSkills` use in the incremental user message; cost from failed attempts. |
| `src/baseline.ts`, `src/review-state.ts` | `incompleteSkills` on the derived baseline and on `ReviewState`. |
| `src/audit.ts` | Uses the record helper for its own `runAgent` calls. |
| `src/cli.ts` | Turns the local file on for `watch`, `review` and `audit`. |

## Tests (each written to fail first)

- `classifyAgentError`: built from the real SDK error classes (`NoObjectGeneratedError`, `APICallError`, `RetryError` wrapping them), one case per class including the `length` versus other finish reason split, and a plain `TypeError` giving `unknown`. A fake object with the right field names is not enough, because the field names are the risk.
- Record and marker: round trip through `formatAgentsMarker` and `parseAgentsMarker`; a message containing `-->` or a newline cannot reach the marker; no model text is present.
- Retry: a retryable failure then success yields the findings and a recovered note; a non-retryable failure is not run twice (the model stub is asserted to be called once for it); a retryable failure with too little time left is not retried and says so; two failures in a row keep the second class; usage from every attempt is summed into the cost.
- Notice: each group renders with the class names; an all-ok round has no notice.
- Baseline: an `agents` marker with one failed skill gives `incompleteSkills`; an incremental round gives that skill the PR's files and the others the delta (assert the two user messages); a KV state round trips the list; a later round that completes the skill clears it.
- Local file: written when enabled, not written when not, a write failure does not fail the review.
- The real-GitHub check from sprint 3 is rerun after the change: `deriveBaseline` on the three incident PRs still derives the same baselines, and an old body with no `agents` marker gives an empty `incompleteSkills`.

## Known limits

- The class table was written from the SDK documentation and not from observed failures. The first real logs may show a class that belongs in `unknown`, or an `unknown` that deserves a class. The classifier is data, so it is cheap to change.
- `schema_mismatch` is retried once. If the cause is a schema the model cannot satisfy, the retry fails the same way and costs one more attempt per affected agent per round.
- The agents marker adds roughly 80 bytes per agent to every review body.
- Reviews posted before this change have no `agents` marker. They are read as having no incomplete agents, which is the sprint 3 behavior.
- The local file has no rotation.
