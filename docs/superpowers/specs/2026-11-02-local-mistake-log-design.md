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
- `finding` is one row per agent finding, logged before the merge so it keeps its skill. It holds `findingKey`, `skill`, `provider`, `model`, `title`, `body`, `severity`, `category`, `confidence`, `evidence`, `suppressible`, `path`, `line`, `startLine`, `suggestion` and `survived`. `findingKey` is a stable hash of path and normalized title. `survived` says whether that key is present in the merged review.
- `event` holds `findingId` (the ledger id for gate events), `status` (`fixed`, `open`, `reopened`, `approved`, `skipped`, `rejected`), `by` (`gate-inferred`, `no-mistakes`, `agent`), `atHead`, `fixCommit`, `note`, and `path`, `title` and `severity` copied from the ledger entry so analysis can join to findings by `findingKey`. The gate writes inferred `fixed` and `reopened` events. Ingest adds no-mistakes decisions.

On ingest `event` records, `runId` is the no-mistakes run id; every other record carries the capture run id. `finding.survived` means the finding survived the agent merge, not the gate ledger's suppression of settled repeats. Gate-inferred `fixed` events carry `fixCommit: null` because the fix commit is derivable from the gap between consecutive gate `run` rows' `headSha` values; `atHead` is the head the gate saw it fixed at.

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

1. Resolve `gate` rows to sessions. First use a `review` row on the same repo and branch that carries a session id, since the agent runs `review --full` before opening the PR. Then scan `~/.claude/projects/<repo>/*.jsonl`. A line counts when its `gitBranch` equals the run branch and its `cwd` is the repo, verified by `cwd` basename (the repo name, or a path containing `/<repo>/.worktrees/`) because a project dir name suffix alone can match a sibling repo. Lines without a `cwd` do not count. Commit shas are not matched. `git commit` and `git push` Bash tool_use calls serve only as a ranking tiebreak between sessions. Anything unresolved stays null.
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

## Observed formats

Inspected 2026-11-02 on one machine (Claude Code 2.1.312, no-mistakes state schema as installed, Codex rollout files dated 2026-11-02). Only key names, types, counts and enum values were read; no message text. "Verified" means observed in real files. Everything else is listed under Unverified.

### Claude Code transcripts

Location: `~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl`, one JSON object per line.

| Finding | Evidence |
| --- | --- |
| Lines of type `user`, `assistant`, `attachment`, `system` carry `sessionId`, `cwd`, `gitBranch`, `timestamp` (ISO), `uuid`, `parentUuid`, `isSidechain`, `version`, `entrypoint`, `slug`. | `jq -r '[.type,has("cwd"),has("gitBranch"),has("sessionId")]\|@tsv' \| sort \| uniq -c` on one 3681-line file. |
| Bookkeeping lines (`ai-title`, `api-request*`, `last-prompt`, `queue-operation`, `tools-used`, `cost-state`) have `sessionId` but no `cwd` or `gitBranch`. `file-history-*` lines have neither `sessionId` nor `timestamp` (delta has `timestamp`). | same command |
| `cwd` and `gitBranch` change inside one session. The sampled file had 1 `sessionId`, 3 distinct `cwd` values (main checkout plus two `.worktrees/<name>` paths) and 4 distinct `gitBranch` values (including `main` and the literal `HEAD`). | `jq -r '.gitBranch // empty' \| sort -u` |
| Worktree sessions are NOT stored under their own project dir when launched from the main checkout. A session started in the main checkout stays in the main project dir even after `cwd` moves into a worktree. Separate `...ai-review-bot--worktrees-<name>` dirs exist (3) only for sessions launched with that cwd. A session for this branch (`feat/mistake-log`) sits in the main project dir. | `ls ~/.claude/projects \| grep ai-review-bot` |
| `~/.claude/projects` also holds hundreds of dirs named `-Users-joe--no-mistakes-worktrees-<repoId>-<runId>` and `...--no-mistakes-repos-<id>-git`. These are the no-mistakes pipeline agents' own sessions, not implementer sessions, and must be excluded from implementer matching. | `ls ~/.claude/projects \| grep -c no-mistakes` |
| Tool calls: assistant `message.content[]` blocks of `type: "tool_use"` with `id`, `name`, `input`. A `Bash` call has `input.command` (+ `description`, `timeout`, `run_in_background`). A `git commit` or `git push` call is identifiable by matching `input.command` (17 and 29 matches in the sample). Results are `user` lines with `message.content[].type == "tool_result"` and `tool_use_id`, plus a top-level `toolUseResult` object (`stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected` for Bash). | `jq` on `.message.content[]` |
| Commit shas do NOT reliably appear in results. 0 of 318 tool results contained a `[branch sha]` commit summary line. A sha is only recoverable if the command or output mentions one. Do not rely on it. | `grep -cE '^\[[^] ]+ [0-9a-f]{7,}\]'` over stdout and `tool_result` text |
| Subagents: stored at `<sessionId>/subagents/agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json` (`agentType`, `description`, `model`, `spawnDepth`, `toolUseId`, `finished`, ...). Their lines have `isSidechain: true`, `agentId`, and the PARENT `sessionId`; they also carry `cwd` and `gitBranch`. The parent's `Agent` tool result has `agentId`. Subagents never get their own top-level `<sessionId>.jsonl`. | `find <session dir> -maxdepth 3`; `jq` on a subagent file |
| Main-session lines have `isSidechain: false` or no such key (non-message types). | `jq -r .isSidechain \| sort \| uniq -c` |
| Env var `CLAUDE_CODE_SESSION_ID` is set in the running session and equals the transcript filename. | `env`, and `ls ~/.claude/projects/*/$ID.jsonl` returned 1 file |

### no-mistakes

Primary store is `~/.no-mistakes/state.sqlite` (tables `repos`, `runs`, `step_results`, `step_rounds`, `agent_invocations`, `run_agent_sessions`, `review_questions`, ...). It holds decisions directly; log files are not needed.

| Item | Observed |
| --- | --- |
| `runs` | `id` (26-char ULID), `repo_id`, `branch`, `head_sha` (40 hex), `submitted_head_sha`, `base_sha`, `status` (`completed`, `failed`, `cancelled`, `running`), `pr_url`, `created_at` and `updated_at` as unix seconds, `intent_session_id`. 271 rows. |
| `repos` | `id`, `working_path` (absolute checkout path), `upstream_url`. Joins `runs.repo_id`. |
| `runs.intent_session_id` | Column exists but is empty in 269 of 271 rows. It does NOT link to an implementer session. `intent_source` is `agent` (262), `rerun` (7) or null. |
| `run_agent_sessions` | `(run_id, role, agent, session_id)`. Only `role = review-fixer`, `agent = claude`, 26 rows. These ids exist as transcripts but are the no-mistakes fixer, not the implementer. |
| `step_results` | `run_id`, `step_name` (`intent`, `rebase`, `review`, `test`, `document`, `lint`, `push`, `pr`, `ci`, plus `gate.review.<gate>` such as `gate.review.ai-review`), `status` (`completed`, `failed`, `skipped`, `pending`, `awaiting_approval`, `fixing`, `fix_review`, `running`), `findings_json`, `skip_reason`, `approval_reason`, `response_origin` (`interactive`, `auto_yes`, `unknown`), `log_path`. A skipped step is `status = skipped` (42 skipped `review` steps; `skip_reason` set on only 3). |
| `step_rounds` | One row per round: `round`, `trigger_type` (`initial`, `auto_fix`), `findings_json`, `reviewed_head_sha`, `starting_head_sha`, `selected_finding_ids` (JSON array of ids), `selection_source` (`user`, `user_declined`, `auto_fix`, null), `user_findings_json`, `fix_summary`, `response_origin`, `created_at`. Counts in sample: `user` 74, `user_declined` 147, `auto_fix` 26. |
| Finding object keys (`findings_json.findings[]`) | `id`, `severity`, `action`, `file`, `line`, `description`, `review_scope`; user-edited copies add `user_instructions` or `driver_instructions`. Round summary keys: `findings`, `risk_level`, `risk_rationale`, `risk_scope`, `summary` (+ `testing_summary`). |
| Decision encoding | Approve, fix and skip are not stored as a verb. Derive per finding: id in `selected_finding_ids` means fixed (fix chosen); id present in `findings_json` but absent from the selection with `selection_source = user_declined` means declined (ignore); `auto_fix` means picked by the pipeline. Step-level skip is `step_results.status = skipped`. A step approved without fixes is `completed` with no selected ids. |
| Machine-readable CLI | `no-mistakes axi rounds --run <runId> --step <stepName> --json` emits `{schema_version, run_id, step, rounds[{round, trigger, summary, findings[], selected_finding_ids[], selection_source, response_origin, user_findings[], fix_summary, duration_ms, created_at}]}`. This is the supported interface; prefer it over reading sqlite. `no-mistakes runs` is human text only (columns: status, branch, short sha, time, PR url) and has no `--json`, only `--limit`. `axi status --run <id>` exists; not inspected beyond `--help`. |
| `~/.no-mistakes/logs/` | Contains `daemon.log` and per-run directories named by run id. Log text is free-form and was not parsed. `step_results.log_path` points at per-step logs. |
| `~/.no-mistakes/evidence/` | Directories named `<64-hex>.git` (bare repos). Not a decision source. |
| `~/.no-mistakes/eval/registry.sqlite` | Tables `cases` (143 rows), `evaluations`, `diversified_pins`, `pending_case_deletions`, `replay_case_reservations` (all others 0). Review-eval fixtures, not live decisions. |

How a run maps to a branch and head sha: `runs.branch` + `runs.head_sha` (and `submitted_head_sha`), plus `step_rounds.reviewed_head_sha` per round, joined to `repos.working_path`. Verified directly in the DB.

### Codex

| Item | Observed |
| --- | --- |
| Session files | `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. Line 1 is a `session_meta`-style object with keys `ordinal`, `payload`, `timestamp`, `type`; `payload` keys include `id`, `session_id`, `cwd`, `git` (`branch`, `commit_hash`, `repository_url`), `cli_version`, `model_provider`, `originator`, `source`. |
| Environment | No Codex-set session variable was visible from inside this Claude session, which is the only place it was checked. The only match for `env \| grep -i codex` was `CODEX_COMPANION_SESSION_ID`, and its value equals the Claude transcript id of the current session (the Codex plugin's companion variable), so it is a Claude id, not a Codex one. |
| Conclusion | Whether a `codex` process exports a session id into the child environment of `ai-review review` is unverified. Recovering a Codex implementer would need a time-and-cwd match against rollout `payload.cwd` and `payload.git`, which is a heuristic. `implementer.agent: "codex"` is not captured reliably; leave it unset rather than guess. |

### Resolution: gate run to implementer session

| Path | Confidence | Notes |
| --- | --- | --- |
| Capture-time `CLAUDE_CODE_SESSION_ID` stored in the gate/review record (the session-capture task already in this design) | High | Exact. Works whenever `ai-review review` or `ai-review gate` ran in the implementer's shell. Under the no-mistakes pipeline the gate runs in a pipeline worktree with its own session env, so this may name a no-mistakes agent, not the implementer. Not verified end to end. |
| Transcript scan: `gitBranch == run.branch` on message lines, window `[firstLine, run.created_at]`, excluding the `-Users-joe--no-mistakes-*` project dirs, preferring the session with a `git commit` or `git push` Bash tool_use nearest before `run.created_at` | Medium | `gitBranch` varies within a session, so test per line, not per file. Sessions on one branch can overlap, so ties need the tiebreak below. |
| `runs.intent_session_id` | None | Empty in practice. |
| `run_agent_sessions` | None for the implementer | Names the fixer. |
| sha in tool results | Low | Not present in the sampled results. |

Recommended minimal algorithm for `mistakes ingest`:

1. Enumerate runs from `state.sqlite` (read-only open) for `repos.working_path` under this repo, or use `axi rounds --json` per `(run, step)` where the sqlite schema is a concern. Key is `(branch, head_sha, created_at)`.
2. Prefer the session id already stored in the capture record for that finding. If present and a transcript with that id exists outside the no-mistakes project dirs, use it with confidence `exact`.
3. Otherwise scan `~/.claude/projects/*ai-review-bot*` excluding `*--no-mistakes-*`. Stream each file with `jq` or line-wise JSON parsing (never load whole files), keep lines with `gitBranch == branch`, and collect per-session `[firstTs, lastTs]`. Candidates are sessions whose range starts before `run.created_at`. Subagent files need not be scanned; they inherit the parent `sessionId`.
4. Rank candidates: a `git commit` Bash tool_use inside the window before `created_at` beats none; then the latest `lastTs` not after `created_at` + a few hours. One clear winner gives confidence `branch-window`; more than one gives `ambiguous` and the best-ranked id with that label; none gives unset.
5. Decisions come only from `step_rounds` / `axi rounds --json`, never from logs. Map per finding as in the Decision encoding row.

Unverified: what `CLAUDE_CODE_SESSION_ID` holds when `ai-review gate` runs inside the no-mistakes pipeline; the exact `axi rounds --json` schema across versions (only `schema_version` is versioned); the `git commit` identification regex beyond key paths; whether Codex exports any session env; whether other repos' runs share these formats.

## Left to the builder

Field naming, ULID or hash for `runId`, stderr wording, and the transcript-matching heuristics once the transcript and no-mistakes formats are inspected.
