# No-mistakes gate adapter

Sprint 6 of the review-accuracy epic (`ai-review-bot-w9b.7`). Parent design: `2026-10-27-review-accuracy-epic-design.md`.

## Why

The review only runs once a PR exists, so every finding costs a push, a bot round and a fix commit. The no-mistakes pipeline already sits in front of the push. Running this review as a custom gate there moves the same findings in front of the PR and keeps the epic's rules: settled findings are not repeated, a round reviews only what changed, and review memory does not depend on KV.

## Goals

- `ai-review gate` runs the full multi-agent review on the branch's changes against its base and writes findings in the no-mistakes custom-gate JSON format.
- A re-check after a fix does not repeat findings that were fixed or that someone settled.
- Works with the repo's own `.no-mistakes.yaml` (dogfood) and is documented well enough for another repo to copy.

## Non-goals

- A reviewer withdrawing its own finding with a stated reason. The ledger spec deferred it here, but it needs a prompt change and a measurement we do not have. Filed as a follow-up on the bead.
- Reading no-mistakes answers (`approve`, `skip`, `fix`). The gate cannot see them (see "What the gate can see").
- Auto-fix. Every finding is reported as `ask-user` or `no-op`.
- Any GitHub read or write. This sprint adds none.
- The parked beads: `ai-review-bot-4ez`, `ai-review-bot-w9b.11`, the model-side filler bead, and the three Sprint 5 P3 bugs.

## Anti-goals

- Ids that change when an unrelated edit shifts a line number. no-mistakes treats a new id as a new finding.
- A gate that fails the pipeline because a provider was slow. Infrastructure failure is a non-zero exit with a message, and a clean review is exit 0.

## The no-mistakes contract

From the [repo config reference](https://kunchenguid.github.io/no-mistakes/reference/repo-config/), read during this sprint:

- `gates: [{name, after, command}]` in `.no-mistakes.yaml`. `after` is `review`, `test`, `lint`, `document` or `rebase`. `command` runs with `sh -c` in the run worktree. The repair budget is `auto_fix.gates.<name>`, default 0. Gates are read only from the default branch's copy of the file, so a new gate takes effect after it is merged.
- Before each run no-mistakes creates an empty file and sets its absolute path in `NO_MISTAKES_FINDINGS_FILE`. The command writes `{"findings":[...]}` to it.
- A finding has `id` (required, unique, stable across runs, no commas), `severity` (`error`, `warning`, `info`), `description` (required), `file`, `line` (not negative) and `action` (`auto-fix`, `ask-user`, `no-op`; default `ask-user`). Unknown fields are rejected. The caps are 1 MiB and 500 findings.
- Exit 0 with no `error` finding passes. Any `error` parks the gate. A non-zero exit parks it with the output attached. An invalid file parks it with one `error`.

On the installed v1.75.2 we ran a gate and saw that it runs after a skipped review, in a detached-HEAD worktree under `~/.no-mistakes/worktrees/`, where `origin/main` exists and `git merge-base HEAD origin/main` returns the fork point. We did not verify the findings-file protocol. v1.75.2 sets no `NO_MISTAKES_*` variable to the gate (the docs describe v1.84.0), and `no-mistakes update` refused because two other pipelines were running. The gate therefore degrades on purpose: with `NO_MISTAKES_FINDINGS_FILE` unset it prints the findings as text and exits 1 when any `error` finding exists, which is the pre-protocol behavior no-mistakes documents for a gate that ignores the file. The protocol path stays unverified live until no-mistakes is updated and a run is driven (a verification step below).

## What the gate can see

It cannot see the answers given through `axi respond`; they are not passed to the command, and the findings file starts empty on every run. The gate keeps its own record and infers outcomes:

- A finding emitted last round and absent now, whose file changed since it was emitted, is `fixed`.
- A finding absent now whose file did not change stays `open`. The model may simply not have raised it again, and calling that fixed would hide a real defect.
- A finding present again keeps its id and stays `open`.
- Fixed and otherwise settled entries suppress a later restatement through the existing `suppressInReview`.

One limit we have not measured: a finding answered `approve` or `skip` in no-mistakes that the model raises again is emitted again under the same id every run. Whether no-mistakes carries its own decision across runs by id is unchecked.

## Design

| Piece | Decision |
| --- | --- |
| Command | `ai-review gate [--base <ref>] [--extra <text>]`. The base defaults to `origin/HEAD`'s target, then `origin/main`, then `origin/master`. The merge base with `HEAD` is the diff start. |
| Scope | New `ReviewScope` kind `range`. `collectFilesFromRange` in `src/sources.ts` lists `git diff --name-only <merge-base> HEAD` and reads each file's content at `HEAD` with `git show`, the same shape as `collectFilesFromCommit`. |
| Review | The provider loop in `runLocalReview` moves into an exported function that returns the merged review and usage without writing a report. `runLocalReview` calls it, so `ai-review review` output is unchanged. |
| Store | `~/.ai-review/gate/<owner>__<repo>__<branch>.json`, written with `saveLedgerFile` (atomic). Outside the worktree, which is deleted with the run. `AI_REVIEW_GATE_DIR` overrides the directory for tests. |
| Round | `max(round) + 1` over the stored ledger. |
| Id | `ai-review-` plus the first 12 hex characters of sha1 of `path` and the lowercased, whitespace-collapsed title. No line number. General findings use path `-`. Collisions within one report get a `-2`, `-3` suffix. |
| Severity | P0 and P1 give `error` and `ask-user`. P2 gives `warning` and `ask-user`. P3 gives `info` and `no-op`. |
| Description | Title, then body, then the suggestion text if present. |
| Exit | 0 when the report is written, even with `error` findings, because the report is how no-mistakes learns about them. Non-zero only when no provider authenticates or every agent fails, as in `runLocalReview`. |
| Fail open | An unreadable or malformed store is treated as empty, logged to stderr, and rewritten. A review is never dropped for it. |

Each emitted finding is stored as a `LedgerEntry`: `status: open`, `decidedBy: null`, `reason: null`, `action` set, and `evidence` holding `head:<sha>` and `blob:<git id of the file at HEAD>`. An inferred fix sets `status: fixed` and appends `inferred: absent after file changed`.

A branch with no code files in range writes `{"findings":[]}` and exits 0 without calling a provider.

## Cost and wiring

A gate run is one full multi-agent review per provider with local subscription auth, the same as `ai-review review`. This repo adds the gate to its own `.no-mistakes.yaml` with `auto_fix.gates.ai-review: 0`, so every no-mistakes run here pays that cost. It is local, personal use under the same ToS boundary as `review` and `audit`; the gate must never be imported from webhook paths.

## Verification

1. Replay harness before and after, recall guard and `negativePairs` green. The before output is saved from this branch's base.
2. Unit tests, written first and seen failing: mapping, id stability and no commas, collision suffix, 500 cap, empty range, fixed inference with and without a changed file, suppression of a settled entry, schema validity against a validator written from the documented schema, and the fallback exit when the findings file is unset.
3. By hand in a scratch repo through `no-mistakes axi run`, two rounds: a finding is reported and parks the gate, a fix commit makes the next round report it fixed and pass. Run on v1.75.2 now (fallback path). Run again on the protocol path once no-mistakes can be updated, and say in the PR if that did not happen.
4. After merge, one real run on a new branch of this repo showing the gate park and then pass, recorded on the PR and on the bead.

Not measured by this sprint: gate precision against real defects, wall-clock and cost per run, and the approve-then-reraise behavior above.

## Left to the builder

File layout inside `src/`, test fixture shapes, and the wording of the stderr diagnostics.
