# Local mistake log

## Why

Reviews now run before the PR exists. The no-mistakes pipeline calls `ai-review gate`, and implementing agents run `ai-review review --full`. The GitHub PR review comments used to be the written record of what agents got wrong, and that record will shrink. The improvement corpus in `src/improve/` can't take local findings, because it is keyed on GitHub comment ids, review ids and PR reactions.

Local runs keep little today.

- `ai-review review` writes a markdown report to `docs/code-reviews/`. The report drops category, confidence, evidence, suggestion and the skill and provider behind each finding. `--json` prints no findings, and `LocalReviewResult.merged` is discarded.
- The gate store under `~/.ai-review/gate/` holds the latest state per finding. It has no per-round snapshots, no earlier bodies and no record of what fixed a finding.
- Nothing links a finding to the agent session that wrote the code under review. That link is what lets us read the transcript and see why the agent erred.
- no-mistakes keeps its own run data under `~/.no-mistakes/` (`logs`, `evidence`, `eval`), including approve, skip and fix answers the gate cannot see. We have not inspected its format.

## Goals

- Persist every finding from `review` and `gate` in full, once per run or round, with reviewer provenance and repo state.
- Attach the implementing session id to a finding when it can be known, and keep the keys (repo, branch, head sha, time) needed to resolve it later when it can't.
- Record fixes and dispositions as later events and never rewrite earlier rows.
- Use a format that loads into Neon later without a rewrite.

## Non-goals

- Neon sync, dashboards, trend detection or any analysis.
- Changes to the hosted bot path, `src/improve/`, the gate store or the markdown reports.
- Copying transcripts. The log stores session ids only.

## Anti-goals

- A logging failure that fails or slows a review or gate run.
- A guessed session link recorded as fact.
- Transcript content or secrets landing in the log or in a repo.

## Approaches

1. **Local append-only JSONL log, loaded elsewhere later.** Chosen. It needs no infrastructure, can't block a review, and keeps what the gate store overwrites. It exists only on this machine.
2. **Write straight into the Neon corpus.** It reuses the cron analysis. The schema is GitHub-keyed, so it needs a migration, and local runs would depend on `DATABASE_URL` and the network.
3. **Commit enriched reports to the repo.** Easy to browse. It makes noisy diffs, stays tied to a branch, and can't link transcripts, which must not be committed.

## Design

### Location

`~/.ai-review/mistakes/<owner>__<repo>/<UTC timestamp>-<runId>.jsonl`, one file per invocation, so concurrent runs never contend and no lock is needed. `AI_REVIEW_MISTAKES_DIR` overrides the root for tests. Per-run files instead of one shared file is a design call.

### Records

Every line has `v: 1`, `type`, `ts`, `runId`, `source` (`review` or `gate`), `repo` and `branch`.

- `run` holds `headSha`, `baseSha` or `mergeBase`, `scope` (`local-changes`, `full-tree`, `commit:<sha>` or `range`), `round`, `costUsd`, `durationSeconds`, `providers`, `models`, `agentsAttempted`, `agentsSucceeded`, `partial`, `reportPath` for `review`, and `implementer`.
- `finding` holds `findingId`, `title`, `body`, `severity`, `category`, `confidence`, `evidence`, `suppressible`, `path`, `line`, `startLine`, `suggestion`, `skills[]`, `provider` and `model`. `findingId` is the ledger id for `gate` and a stable hash of path, title and head sha for `review`.
- `event` holds `findingId`, `status` (`fixed`, `open`, `reopened`, `approved`, `skipped`, `rejected`), `by` (`gate-inferred`, `no-mistakes`, `agent`), `atHead`, `fixCommit` and `note`. The gate writes inferred `fixed` and `reopened` events. Ingest adds no-mistakes decisions.

`implementer` is `{agent: "claude-code" | "codex" | null, sessionId, source: "env" | "resolved" | null, confidence}`.

- `review` reads `CLAUDE_CODE_SESSION_ID` from the environment, which is set in a Claude Code session. The Codex equivalent, and whether a subagent sees its own id or its parent's, are not verified. The builder checks both and records `source: null` where unsure.
- `gate` runs in a no-mistakes worktree with no session environment. It records `implementer` as null and relies on ingest.

### Write path

New `src/mistakes/` holds `types.ts` (zod schemas), `log.ts` (`openMistakeLog`, `appendRun`, `appendFinding`, `appendEvent`) and `session.ts` (environment lookup). Writes fail open. An error is caught, one warning goes to stderr, and the run continues.

- `runLocalReview` in `src/audit.ts` writes after the provider passes and the merge, while `merged` is in scope and before the report is written.
- `src/gate/run.ts` writes after `applyRound`. It logs a `finding` for every entry reviewed this round and an `event` for each inferred fix or reopen.
- Per-finding skill provenance exists today only as the merge-time `commentProvenance` map used for GitHub posting. `src/review.ts` must expose it to the local path.

### Ingest

`ai-review mistakes ingest [--repo <owner/name>]` reads capture files and writes annotations. It never modifies a capture file.

1. Resolve `gate` rows to sessions. First use a `review` row on the same repo and branch that carries a session id, since the agent runs `review --full` before opening the PR. Then scan `~/.claude/projects/<repo>/*.jsonl` for a matching branch, cwd or commit sha. Anything unresolved stays null. Whether transcripts record branch or cwd is unverified.
2. Join no-mistakes decisions for the same branch and head from `~/.no-mistakes/`. The builder inspects the run logs and `eval` cases first.
3. Write results as `event` and `implementer` annotation lines in an `ingest-<ts>.jsonl` file beside the capture files.

### Privacy

The log lives under `~/.ai-review/`, outside every repo. Finding bodies can quote code, which is fine locally. Only session ids are stored.

### Constraints

`src/mistakes/` is CLI-only. It is never imported from webhook paths, the same rule as `src/gate/` and `src/auth.ts`.

## Delivery

One branch, one PR through `/no-mistakes`: this spec first, then the plan, then the implementation. Capture for `review` and `gate` lands first because it stops the data loss. Ingest follows.

## Verification

1. Tests written first and seen failing:
   - schema round-trip
   - one `finding` line per merged finding, with skills, provider and model filled in
   - fail-open on an unwritable directory, with the review still succeeding and one warning
   - session capture with the environment variable present and absent
   - gate `event` on an inferred fix and on a reopen
   - `partial` set on a partial round
   - ingest never mutating capture files
2. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
3. Smoke test. Run `ai-review review` in a scratch repo and check every field in the JSONL. Run two gate rounds (a finding, then a fix commit) and confirm `finding` rows for both rounds plus a `fixed` event.
4. Run `ai-review mistakes ingest` on the real `feat/review-precision-phase-b*` branches and report how many gate rows resolved to a session, and by which path.

## Left to the builder

Field naming, ULID or hash for `runId`, stderr wording, and the transcript-matching heuristics once the transcript and no-mistakes formats are inspected.
