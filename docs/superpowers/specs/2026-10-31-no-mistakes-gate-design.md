# No-mistakes gate adapter

Sprint 6 of the review-accuracy epic (`ai-review-bot-w9b.7`). Parent design: `2026-10-27-review-accuracy-epic-design.md`.

## Why

The review only runs once a PR exists, so every finding costs a push, a bot round and a fix commit. The no-mistakes pipeline already sits in front of the push. Running this review as a custom gate there moves the same findings in front of the PR and keeps the epic's rules: settled findings are not repeated, a later round reviews only the files that changed since the last one, and review memory does not depend on KV.

## Goals

- `ai-review gate` runs the multi-agent review on the branch's changes against its base and writes findings in the no-mistakes custom-gate JSON format.
- A re-check after a fix stops reporting the findings that were fixed, and does not re-review files that did not change since the last round.
- Works with this repo's own `.no-mistakes.yaml` (dogfood) and is documented well enough for another repo to copy.

## Non-goals

- A reviewer withdrawing its own finding with a stated reason. The ledger spec deferred it here, but it needs a prompt change and a measurement we do not have. Filed as a follow-up on the bead.
- Reading no-mistakes answers (`approve`, `skip`, `fix`). The gate cannot see them.
- Hunk-level deltas. The delta is per file, because the audit path hands agents whole files.
- Auto-fix. Every finding is reported as `ask-user` or `no-op`.
- Any GitHub read or write.
- The parked beads: `ai-review-bot-4ez`, `ai-review-bot-w9b.11`, the model-side filler bead, and the three Sprint 5 P3 bugs.

## Anti-goals

- A fixed finding that comes back under a new id, or a still-present defect marked fixed and then hidden. The second is worse: the gate would exit 0 over a real bug.
- A gate that fails the pipeline because a provider was slow. Infrastructure failure is a non-zero exit with a message, and a clean review is exit 0.

## The no-mistakes contract

From the [repo config reference](https://kunchenguid.github.io/no-mistakes/reference/repo-config/), read during this sprint:

- `gates: [{name, after, command}]` in `.no-mistakes.yaml`. `after` is `review`, `test`, `lint`, `document` or `rebase`. `command` runs with `sh -c` in the run worktree. The repair budget is `auto_fix.gates.<name>`, default 0. Gates are read only from the default branch's copy of the file, so a new gate takes effect after it is merged.
- Before each run no-mistakes creates an empty file and sets its absolute path in `NO_MISTAKES_FINDINGS_FILE`. The command writes `{"findings":[...]}` to it.
- A finding has `id` (required, unique, stable across runs, no commas), `severity` (`error`, `warning`, `info`), `description` (required), `file`, `line` (not negative) and `action` (`auto-fix`, `ask-user`, `no-op`; default `ask-user`). Unknown fields are rejected. The caps are 1 MiB and 500 findings.
- Exit 0 with no `error` finding passes. Any `error` parks the gate. A non-zero exit parks it with the output attached. An invalid file parks it with one `error`.

On the installed v1.75.2 we ran a gate and saw that it runs after a skipped review, in a detached-HEAD worktree under `~/.no-mistakes/worktrees/`, where `origin/main` exists, the pushed branch exists as a local ref, and `git merge-base HEAD origin/main` returns the fork point. We did not verify the findings-file protocol. v1.75.2 sets no `NO_MISTAKES_*` variable to the gate (the docs describe v1.84.0), and `no-mistakes update` refused because two other pipelines were running. The gate therefore degrades on purpose: with `NO_MISTAKES_FINDINGS_FILE` unset it prints the findings as text and exits 1 when any `error` finding exists, which is the pre-protocol behavior no-mistakes documents for a gate that ignores the file. The protocol path stays unverified live until no-mistakes is updated and a run is driven (a verification step below).

## What the gate can see

It cannot see the answers given through `axi respond`. They are not passed to the command, and the findings file starts empty on every run. The gate keeps its own record (the store, below) and infers outcomes, in this order each round:

1. Review the files in scope (see Scope).
2. Match each new finding against the store's open entries with the ledger's claim-matching rules, run over open entries instead of settled ones. A match keeps the entry's id and refreshes its title, line and body.
3. Take each remaining new finding. If it matches an entry the gate inferred as fixed, reopen that entry under its id with refreshed fields and emit it. Otherwise suppress it when it matches an entry a person settled before this round (`decidedBy` not null), using `suppressInReview` after `mergeReviews`. The gate records no person's decision today, so in practice nothing is suppressed; the rule stays so a later source of real decisions needs no change here.
4. An open entry that no new finding matched becomes `fixed` only if its file's diff against the merge base changed since the entry was last seen, or the file left the range (its path is absent from the range even when the round skipped it for review), and only if the round was complete (see Partial rounds). Otherwise it stays `open`: the model may simply not have raised it again.

Open entries on files a delta round did not review are reported again from the store, so a later round never goes green over a known defect. Entries without a file path are reported in the round that raises them, and again on any later round at the same `HEAD` (so re-running the pipeline without a code change cannot turn a parked gate green); nothing can ever mark them fixed, so they are not carried past a changed `HEAD`.

An inferred fix is a guess, so it never suppresses anything. A model that misses a finding in one round and raises it again after an unrelated edit to the file would otherwise be silenced for good, with the gate exiting 0 over a real defect. Reopening costs a repeat when a fix was real and the model raises it again anyway, which is the cheaper error.

Known limit, not measured: a finding answered `approve` or `skip` in no-mistakes that the model raises again is emitted again under the same id every run. Whether no-mistakes carries its own decision across runs by id is unchecked.

## Design

| Piece | Decision |
| --- | --- |
| Command | `ai-review gate [--base <ref>] [--extra <text>]`. |
| Base | `--base`, else a new exported resolver: `origin/HEAD`'s target, then `origin/main`, then `origin/master`. The existing private `defaultBranch` in `src/sources.ts` falls back to bare `main`, which does not exist in a run worktree, so the gate does not reuse it as is. The diff start is `git merge-base <base> HEAD`. |
| Scope | New `ReviewScope` kind `range`. `collectFilesFromRange` in `src/sources.ts` lists `git diff -M --name-status <merge-base> HEAD`, reads each surviving file at `HEAD` with `git show`, and reports renames as old and new path. Round 1 reviews every file in range. A later round reviews only the files named by `git diff --name-only <lastHead> HEAD` plus files holding an open entry whose stored diff hash differs from the current one, provided the stored head is still an ancestor of `HEAD`. A force-push or rebase that breaks that gives a full-range round, and every entry stays `open` for it. |
| Review | The provider loop in `runLocalReview` moves into an exported function that returns `{merged, costUsd, providersRun, agentsAttempted, agentsSucceeded}` and writes no report. `runLocalReview` calls it, so `ai-review review` output is unchanged. |
| Store | One JSON file per repo and branch under `~/.ai-review/gate/` (`AI_REVIEW_GATE_DIR` overrides it for tests). The run worktree is detached, so the branch comes from `git for-each-ref --points-at HEAD refs/heads/`. If that gives zero or several branches, the key is the merge-base sha. The file name is the sha256 of `owner/repo` plus the percent-encoded branch or merge base, never raw branch text. It holds the entries, the provider set and the head of the last complete round. |
| Concurrency | The store carries a `revision` counter (a file without one loads as 0). A save re-reads the file first. If its revision still equals the one this run loaded, the save writes revision + 1. If another run saved in between, the save merges instead of overwriting: entries are united by id (when both hold an id, the higher `round` wins and a tie keeps the copy on disk), the provider sets are united, `lastHead` is cleared so the next round reviews the full range and skips nothing the other run saw, and the revision becomes the larger of the two plus one. The gate prints a warning when it merged. Writes use a unique temp name (pid plus random) and an atomic rename. The re-read and the rename are not one atomic step, so two saves within milliseconds of each other can still lose one round; there is no lock file. |
| Round | `max(round) + 1`. |
| Id | Minted when a finding first appears: `ai-review-` plus 12 hex characters of sha1 over path, title and the head sha at first sight. After that the id belongs to the entry, not to the title, so a paraphrased title or a moved line keeps its id. A rename moves the entry to the new path and keeps the id. The renames come from `git diff -M` between the head in the entry's `head:` evidence and `HEAD`, only when that head is an ancestor of `HEAD`, and a moved entry's `head:` is set to `HEAD`, so a rename is applied once and an entry moved in an incomplete round still follows the next rename. An entry whose head is not an ancestor keeps its path. Two new findings with the same hash input get `-2`, `-3` in the order of their body hash, so the suffix does not depend on agent timing. A match refreshes the entry's title, body, line and severity, so a finding raised again at a lower severity lowers the entry's severity. |
| Severity | P0 and P1 give `error` and `ask-user`. P2 gives `warning` and `ask-user`. P3 gives `info` and `no-op`. |
| Description | Title, then body, then the suggestion text for an inline comment that has one. General findings have no path, so `file` and `line` are omitted. |
| Cap | Over 500 findings, drop lowest severity first, newest first, and print the dropped count to stderr. An `error` is dropped only after everything else is gone. |
| Exit | 0 when the report is written, even with `error` findings, because the report is how no-mistakes learns about them. Non-zero when no provider authenticates or every agent fails, as in `runLocalReview`. |

Each emitted finding is stored as a `LedgerEntry`: `status: open`, `decidedBy: null`, `reason: null`, `action` set, and `evidence` holding `head:<sha>` and `diff:<sha1 of git diff <merge-base> HEAD -- <path>>`, with the path-bearing header lines removed so a pure rename keeps its hash (for a rename the diff is taken with `-M` over the old and new path). Comparing the diff against the merge base, not the whole file, keeps a rebase onto a moved base from looking like an edit only while the file's hunk headers stay put. An upstream edit above a hunk shifts its line numbers and changes the hash, so a rebase can cause one extra re-review of that file, and if the model misses the finding in two such rounds in a row, the second can infer a fix. An inferred fix sets `status: fixed` and appends `inferred: absent after diff changed`.

A branch with no code files in range writes `{"findings":[]}` and exits 0 without calling a provider.

### Partial rounds

A provider whose every agent failed (an exhausted balance, a revoked login) counts as a provider that did not run. For the rest, step 4 runs only when every attempted agent succeeded and the providers that ran include every provider in the stored set. A larger set is fine: every provider that could have raised a stored finding looked again. A set that is missing a stored provider is a mismatch. Otherwise new findings are still emitted and matched, every unmatched entry stays `open`, and the gate prints a warning. The stored provider set only grows: after every round that ran a review it holds the union of its old members and the providers that ran, so any provider that raised an open entry is always in it (a provider can raise a finding in an incomplete or mismatched round, and must not be able to drop out and have that finding inferred fixed later). `lastHead` advances only on a complete round without a mismatch, so a delta round after a mismatch re-reviews everything changed since the last good one. The cost is that after a permanent provider change the old findings stay open until the store file is deleted; the warning names that file. A missing provider or a timed-out skill would otherwise read as "everything it found is fixed".

### Fail open

If the store is unreadable, malformed or has invalid entries, the gate moves it aside to `<name>.corrupt-<timestamp>`, starts from an empty store, and prints that history was reset. The cost is that findings fixed earlier can come back as open, and an `error` among them parks the gate again. It never drops a review.

## Cost and wiring

A gate run is one multi-agent review per authenticated provider with local subscription auth, the same as `ai-review review`. This repo adds the gate to its own `.no-mistakes.yaml` with `auto_fix.gates.ai-review: 0`, so every no-mistakes run here pays that cost. It is local, personal use under the same ToS boundary as `review` and `audit`. The gate must never be imported from webhook paths.

## Verification

1. Replay harness before and after, recall guard and `negativePairs` green. The before output is saved from this branch's base.
2. Unit tests, written first and seen failing: mapping, lineage id stability across a paraphrased title and a rename, hash-input collision order, 500 cap order, empty range, step 2 matching against open entries, step 4 fixed inference with and without a changed diff, no same-round suppression by an inferred fix, partial-round guard, file-level delta selection and the non-ancestor fallback, store key under a detached HEAD, corrupt store moved aside, schema validity against a validator written from the documented schema, and the fallback exit when the findings file is unset.
3. By hand in a scratch repo through `no-mistakes axi run`, two rounds: a finding is reported and parks the gate, a fix commit makes the next round report it fixed and pass. Run on v1.75.2 now (fallback path). Run again on the protocol path once no-mistakes can be updated, and say in the PR if that did not happen.
4. After merge, one real run on a new branch of this repo showing the gate park and then pass, recorded on the PR and on the bead.

Not measured by this sprint: gate precision against real defects, wall-clock and cost per run, and the approve-then-reraise behavior above.

## Left to the builder

File layout inside `src/`, test fixture shapes, and the wording of stderr messages.
