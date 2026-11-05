# Composite operations

Changes that are several operations at once, or an operation whose danger is in how it
interacts with another. The other families describe one thing done to code. These entries
describe what goes wrong when things are combined or arrive in the wrong packaging: a refactor
carrying a fix, a "cleanup" that is five PRs, a test edited to match the code it tests, a
column renamed in the same release as the code that reads it.

The review move is mostly about splitting. The guide asks for it directly: past a few hundred
lines, ask for a split along a seam, and keep mechanical edits in their own commits so the
behavior change stays legible
([size the change](../../Code-Review-Guide-and-Playbooks.md#size-the-change-before-reading-it)).
When a PR can't be split, the reviewer takes it apart mentally: label each hunk with the
operation it belongs to, narrow review on the mechanical and relocated parts
([mechanical.md](mechanical.md), [relocation.md](relocation.md)), and spend the saved effort on
the behavioral ones ([behavior.md](behavior.md)). Removed code gets the checks in
[deletion.md](deletion.md), and contract changes the ones in [interface.md](interface.md).

The guide also allows a large change to be reviewed in two rounds, scope and design first and
line-level comments after
([review order](../../Code-Review-Guide-and-Playbooks.md#review-in-the-order-of-make-it-work-make-it-right-make-it-fast)).
For a composite, the first round is the classification of what the PR contains.

## CMP-01: Refactor mixed with a behavior change

```yaml
id: CMP-01
name: Refactor mixed with a behavior change
family: composite
aliases: [refactor and fix, drive-by fix, no-functional-change PR, boy scout change]
signals:
  - a description that says "refactor", "cleanup" or "no functional change", with a changed condition, constant, default or call in the diff
  - extracted, moved or renamed code in which a body differs by a few logic lines
  - a test added or modified inside a PR labelled as refactoring
  - mechanical-looking hunks (renames, signature tidying) next to hunks that change a branch
narrows_playbooks: true
escalates_with: [public-api, trust-boundary, auth, data-write, money, critical-path]
guide_refs:
  - "#size-the-change-before-reading-it"
  - "#hand-the-mechanical-rules-to-tools"
  - "#review-in-the-order-of-make-it-work-make-it-right-make-it-fast"
  - "#tests-levels-coverage-gaps-and-tdd"
tools: [tree-sitter-diff, color-moved, blame-C, log-L, read-file, linked-work-item, ci-results]
bot_visibility: none
```

### What it looks like in a diff

Mostly motion, with a few lines of logic. A function is extracted and one of the extracted
lines is different from the original. A class is split and a default changes in the new
constructor. A rename PR that also drops a null check.

### How to recognize it

Compare each moved, extracted or renamed body with its original, ignoring whitespace and the
symbol's name. Any remaining difference is the behavior change. [REL-10](relocation.md#rel-10-move-plus-modify)
is the same detection for one moved symbol. This entry is the PR-level version: the whole PR
claims to be a refactor, and the job is to find every hunk that isn't.

### Likely intents

1. A "while I was in there" fix the author noticed during the refactor.
2. A change that made the refactor compile (an import or a parameter), which is mechanical.
3. The refactor was cover for a change that would have been questioned alone.
4. An accident from the transformation, a behavior change the author didn't mean.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Which hunks are pure motion? | Side-by-side with moved lines highlighted | `color-moved`, `tree-sitter-diff` |
| What is each leftover difference? | Diff old body against new body | `tree-sitter-diff`, `blame-C` |
| What did the original code do, and why? | Timeline on the original lines | `log-L`, `blame-C` |
| What does the PR claim? | Description and ticket | `linked-work-item` |
| Do tests cover the changed lines? | Check test diff and CI | `read-file`, `ci-results` |

### What not to spend review on

Lines that moved or were renamed without any difference. They keep their earlier review.

### Checklist

- **Every residual difference is classified**, as a deliberate behavior change, a compile
  necessity, or an accident. Each one is named in a comment.
- **The behavior change is stated in the description**, with the intent. "No functional change"
  next to a functional change is the sharpest finding available, because the author's own
  statement is wrong.
- **The behavior change gets its domain playbook**, as new logic: a changed guard in an auth
  path gets the auth checklist, not a skim.
- **Ask for a split.** The refactor goes first as its own commit or PR, then the fix. The guide
  says the same for renames, moves and formatting. The split also lets the refactor be
  verified by "tests unchanged and green".
- **Tests did not change in the refactor commit.** A refactor with edited tests is a refactor
  that changed behavior, or tests that were adjusted to the new behavior (see
  [CMP-05](#cmp-05-tests-changed-to-match-new-behavior)).
- **The fix has its own test**, which fails without it
  ([tests: bug fixes](../../Code-Review-Guide-and-Playbooks.md#tests-levels-coverage-gaps-and-tdd)).

### How it combines with domain playbooks

It narrows them for the pure motion and widens them for the residuals. The playbooks are not
skipped for the PR as a whole, only for the lines that earned it.

### Red flags

- A security check, limit, default, retry or timeout changed inside moved code.
- "No functional change" in the title of a PR with a test change.
- A refactor commit that also upgrades a dependency or changes config.
- A rename of something that is serialized.

### Worked example

"Refactor: extract `PricingRule`" moves 60 lines out of `quote()`. In the extracted class,
`round(total, 2)` has become `int(total * 100) / 100`. That truncates where the original
rounded, so some quotes drop by a cent. The review says so on that line, notes the description
claims no functional change, and asks for the extraction to be separated from any intended
rounding change. The other 59 lines get no comments.

### ai-review-bot today

The bot has no move or extraction detection, so every line of the extraction is reviewed as new
and the one changed line has no more weight than the rest. Under budget pressure, deletion-only
hunks are dropped, which removes the original side that the changed line should be compared
with. What it would need: pairing of removed and added blocks, with only the residual
differences flagged.

### Eval seed

On a "no functional change" extraction with one changed rounding call, the review flags that
call, says it contradicts the description, and leaves the moved lines alone.

## CMP-02: Cleanup PR that is really several PRs

```yaml
id: CMP-02
name: Cleanup PR that is really several PRs
family: composite
aliases: [kitchen-sink PR, mega-PR, omnibus change, big-bang cleanup, "misc fixes"]
signals:
  - 'a title like "cleanup", "misc", "tidy", "various fixes", "chore: updates"'
  - several unrelated file clusters (a dependency bump, a rename, a fix, a formatter run, a new helper) in one diff
  - multiple domains in one PR (a migration, an endpoint, a CI workflow, docs)
  - dozens of commits with unrelated messages, or one giant commit
  - changed-line count well past a few hundred, with many files
narrows_playbooks: true
escalates_with: [public-api, migration, auth, data-write, money]
guide_refs:
  - "#size-the-change-before-reading-it"
  - "#review-in-the-order-of-make-it-work-make-it-right-make-it-fast"
  - "#simplicity-and-scope"
  - "#appendix-pull-request-description-template"
tools: [pr-files-api, linked-work-item, tree-sitter-diff, module-graph, ci-results]
bot_visibility: partial
```

### What it looks like in a diff

A long file list that doesn't read as one story. Some files are mechanical, some are new code,
some are config. The description is vague or lists items with "also".

### How to recognize it

Cluster files by directory and kind, then label each cluster with an operation from this
catalog: formatter, rename, dependency bump, new feature, fix, deletion, config. If you get
three or more labels with different intents, it is several PRs. Check also whether the clusters
could land in any order (independent) or depend on one another (a real unit).

### Likely intents

1. Genuine tidy work that accumulated on a branch.
2. An unfinished branch where the author stopped splitting.
3. Packaging to avoid review, which is rare and not worth guessing at.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What operations does the PR contain? | Group the file list by kind | `pr-files-api` |
| Which groups are independent? | Check imports between them | `module-graph` |
| What does the author say it is for? | Read description and ticket | `linked-work-item` |
| Is any group mechanical? | Compare with the mechanical family | `tree-sitter-diff` |
| What does CI say? | Which jobs ran and failed | `ci-results` |

### What not to spend review on

Clusters that classify as mechanical, relocated or generated, once they are identified and
spot-checked against their tool.

### Checklist

- **Classify before commenting.** The first review comment on a PR like this is a list of the
  operations found, with file clusters per operation. It shows the author what the reviewer
  saw.
- **Ask for a split along a seam**: mechanical vs behavior, schema vs code, new module vs call
  site migration, the guide's own examples. State the order the pieces should land in.
- **If a split is refused, review in two rounds.** The first covers scope and design across
  the clusters. The second covers lines, once the clusters are settled.
- **Review the behavioral cluster in full**, with its domain playbook, as though the PR
  contained only that cluster.
- **Find what is hiding.** In a large mixed PR, a behavior change tends to sit inside the
  mechanical hunks. Run the "is it really only mechanical?" check on every mechanical cluster.
- **Out of scope is named.** The guide's description template asks for it
  ([PR description template](../../Code-Review-Guide-and-Playbooks.md#appendix-pull-request-description-template)).
- Each cluster has an independent rollback story. If one has to be reverted, the others
  should survive.

### How it combines with domain playbooks

It narrows and widens by cluster. This entry is a router: it sends each cluster to its own
family and domain, and leaves the combined PR with no playbook of its own.

### Red flags

- A migration or auth change in a PR titled "cleanup".
- A single commit with the whole PR.
- Mechanical clusters hundreds of lines long and a behavior cluster of three lines.
- A description that lists none of the clusters.

### Worked example

"chore: cleanup" has 80 files: 60 are a formatter run, 12 rename `getUser` to `fetchUser`, 6
bump a dependency, and 2 change the default `page_size` from 50 to 500 in `api/pagination.py`.
The review's first comment lists the four operations. It approves the first three by their
tool, then asks for the `page_size` change to be its own PR because it changes the load on
every list endpoint.

### ai-review-bot today

All files go into one prompt, ordered by main language and patch size. Every agent reviews the
whole mixture with the same attention per line. `classifyTier()` sees only totals and path
keywords, so the router doesn't know the PR is mixed, and a large mechanical share can push the
whole PR into the complex tier. What it would need: a classification pass that labels file
clusters before the agents run, and a per-cluster review plan.

### Eval seed

On a PR combining a formatter run, a rename and a two-line default change, the review lists
the three operations and puts its substantive comment on the default.

## CMP-03: Revert

```yaml
id: CMP-03
name: Revert
family: composite
aliases: [git revert, rollback commit, back out, undo merge, revert of a revert]
signals:
  - a commit or PR message "Revert \"...\"" and "This reverts commit <sha>." (the default `git revert` text)
  - a diff that is close to the inverse of an earlier PR on the same files
  - the PR title names a PR number and says revert, roll back or back out
  - a revert that also contains a fix or a part of the original change kept
narrows_playbooks: true
escalates_with: [migration, data-write, public-api, money, critical-path]
guide_refs:
  - "#migrations-and-deployment-sequencing"
  - "#compatibility-hyrums-law"
  - "#readability-and-review"
  - "#size-the-change-before-reading-it"
tools: [log-L, blame-C, read-file, linked-work-item, ci-results, ripgrep]
bot_visibility: none
```

### What it looks like in a diff

The reverse of an earlier change. Added lines in the original are removed, removed lines
return. In TypeScript or Python alike, the hunks mirror a PR that merged recently.

### How to recognize it

The commit message from `git revert` names the original commit. Without it, compare the
revert's removed and added lines to the original PR's added and removed lines. `git log -L` on
the file shows the original. A near-exact inverse is a clean revert. Any difference is a
revert plus an edit.

### Likely intents

1. Back out a change that broke production, quickly.
2. Back out a change that isn't ready, to keep the branch releasable.
3. Resolve a conflict with another change.
4. Undo a merge that went in with the wrong target.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What is being reverted, and why? | Read the original PR and the incident or issue | `linked-work-item`, `log-L` |
| Is the revert an exact inverse? | Compare against the original diff | `blame-C`, `read-file` |
| What landed since the original? | Later commits that built on it | `log-L`, `ripgrep` for the original's symbols |
| Did the original touch data or schema? | Migrations or backfills in the original | `read-file` on the original's files |

### What not to spend review on

The restored lines, if the revert is an exact inverse. They are the pre-change code and were
reviewed before.

### Checklist

- **It is an exact inverse, or the differences are named.** A revert with extra edits is a
  composite and gets those edits reviewed as new code
  ([CMP-01](#cmp-01-refactor-mixed-with-a-behavior-change)).
- **Later work that depended on the original is handled.** Code merged after the original that
  calls its new functions or reads its new fields breaks when they vanish. Search for the
  original's added symbols at head.
- **Data and schema state is consistent with the reverted code.** If the original ran a
  migration or wrote new data, reverting the code leaves the schema and rows in the new shape.
  The guide's [migrations playbook](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)
  applies, because rolling back code is not rolling back the database.
- **Old clients and consumers are considered.** If the original published an endpoint, event or
  config key and anyone adopted it, the revert is itself a breaking change
  ([Hyrum's Law](../../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law)).
- **The cause is tracked.** A revert fixes the symptom; an issue or note names what must be
  true before the change returns.
- **Reverting a revert** (re-landing) is reviewed as the original change again, plus whatever
  fixed the reason for the revert.
- Tests and flags added by the original are removed or kept deliberately.

### How it combines with domain playbooks

It narrows them for the restored code and widens the migration and compatibility checks, since
state outlives the code. A hasty revert of a data-writing change is the riskiest case.

### Red flags

- A revert of a PR with a migration, with no mention of the schema.
- A revert that also changes unrelated lines.
- Commits after the original that use its additions.
- A revert merged with no ticket for the underlying problem.

### Worked example

"Revert: add `deleted_at` soft delete" removes the column from the model and the filter from 14
queries. The original PR's migration added the column and a partial index, and rows have been
soft-deleted for three days. The review asks what happens to those rows: the reverted code now
returns them as live records. It asks for a plan (keep the column, or backfill) before merging.

### ai-review-bot today

A revert reads as a deletion plus an addition. Nothing links it to the original PR, and the
original's migration isn't visible. The agents may comment on the restored code as new code.
What it would need: the original PR's diff to check "exact inverse", and a search for
later dependents.

### Eval seed

On a revert of a PR that added a column and rows, the review asks about existing data and doesn't
comment on the restored lines.

## CMP-04: Cherry-pick or backport

```yaml
id: CMP-04
name: Cherry-pick or backport
family: composite
aliases: [backport, hotfix to release branch, port to LTS, forward-port, cherry pick]
signals:
  - a commit message with "(cherry picked from commit <sha>)", added by `git cherry-pick -x`
  - the PR base is a release, maintenance or LTS branch (`release/*`, `v2.x`, `stable`) and not the default branch
  - a title like "[backport 2.4] ...", or a bot-created backport PR
  - a diff that matches an earlier change on the default branch, with conflict-resolution edits
narrows_playbooks: true
escalates_with: [public-api, migration, data-write, auth, critical-path]
guide_refs:
  - "#compatibility-hyrums-law"
  - "#migrations-and-deployment-sequencing"
  - "#size-the-change-before-reading-it"
  - "#tests-levels-coverage-gaps-and-tdd"
tools: [linked-work-item, read-file, log-L, blame-C, ci-results, ripgrep, pr-files-api]
bot_visibility: none
```

### What it looks like in a diff

A change already reviewed and merged elsewhere, applied to older code. If the target branch has
drifted, the diff includes edits that the original did not have: moved context, adapted
function names, dropped hunks.

### How to recognize it

The cherry-pick trailer or the PR description names the source commit or PR. Compare the
backport with the original: `git range-diff` and `git patch-id` are the tools for comparing
patches across branches. A matching patch id means identical changes; a difference means the
backport was adapted.

### Likely intents

1. Ship a fix to a supported release without taking everything on the default branch.
2. Bring a feature to a maintenance branch (rarer, and usually a policy question).
3. A forward-port of a release-branch hotfix to the default branch.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What is the original, and was it approved? | Open the source PR | `linked-work-item` |
| How does the backport differ from it? | Compare patches | `read-file` on both diffs, `log-L` |
| Is the code it touches the same on the target branch? | Compare the function at both bases | `read-file` at the target base |
| Does the target branch have the things the fix assumes? | Look for dependencies on prior changes | `ripgrep`, `blame-C` |
| Does CI run on the target branch? | Check the pipeline for release branches | `ci-results` |

### What not to spend review on

Hunks identical to the original, which had its review on the default branch.

### Checklist

- **The delta from the original is explained.** Every hunk that differs is adapted for a
  reason: a renamed function, a missing helper, a different signature. Adapted hunks are
  reviewed as new code.
- **The fix is complete on this branch.** A cherry-pick that applied only the code part of a
  PR and dropped its migration, its config or its dependent change can fail or half-work.
- **Prerequisites are present.** The original may rely on an earlier commit that isn't on the
  release branch. Search for symbols it uses.
- **Release policy is met.** Release branches usually accept fixes only. A feature or a
  behavior change on a stable branch breaks the guarantee users chose the branch for
  ([Hyrum's Law](../../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law)).
- **Tests ran on the target branch.** A fix that passes tests on `main` may fail against the
  older dependencies of the release branch.
- **Migrations keep their order.** A backported migration with a revision that conflicts with
  one on the release branch breaks the chain
  ([migrations](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)).
- The release notes or changelog for that branch mention the fix.

### How it combines with domain playbooks

It narrows them to the unadapted hunks. Adapted hunks and anything that interacts with
older code get the domain's full review.

### Red flags

- A backport that includes unrelated changes picked up by a conflict resolution.
- A backport of a migration.
- A backport whose tests were changed to pass.
- No link to the original.

### Worked example

"[backport 3.2] Fix timezone parsing" cherry-picks a PR onto `release/3.2`. The original uses
`zoneinfo`; 3.2 supports Python 3.8, which doesn't have it. The backport swaps in
`pytz` in one hunk. The review checks that one hunk and the dependency declaration on the
release branch, and makes no comments on the rest.

### ai-review-bot today

A backport is reviewed as a fresh change. The bot can't see the original, and it doesn't treat
the base branch as meaningful (`classifyTier()` uses paths and line counts only). It will repeat
or contradict comments made on the original PR. What it would need: the source PR and its
review thread, and the diff between the two patches.

### Eval seed

On a backport that swaps one API call to suit an older runtime, the review comments on that
adaptation and not on the identical hunks.

## CMP-05: Tests changed to match new behavior

```yaml
id: CMP-05
name: Tests changed to match new behavior
family: composite
aliases: [weakened assertion, test bent to pass, snapshot update, expected value copied from output, skip added, xfail added]
signals:
  - 'an assertion loosened: `assertEqual` to `assertTrue`, `toEqual` to `toBeTruthy` / `toBeDefined` / `expect.anything()`, an exact value to a range or `in`'
  - '`@pytest.mark.skip`, `@pytest.mark.xfail`, `it.skip`, `xit`, `describe.skip`, `test.todo`, `pytest.importorskip` added'
  - an expected literal in a test edited to match what the code now returns
  - '`-u` / `--update-snapshot` run, `.snap` files rewritten'
  - a mock added around the code under test, or a mock's return value edited to fit
  - test deletions alongside production edits, or a test's inputs narrowed
narrows_playbooks: false
escalates_with: [public-api, money, auth, critical-path, data-write]
guide_refs:
  - "#tests-levels-coverage-gaps-and-tdd"
  - "#test-code-itself-helpers-fixtures-and-fakes"
  - "#ai-generated-and-ai-assisted-code"
  - "#reviewing-code-against-its-spec"
tools: [read-file, log-L, blame-C, linked-work-item, ci-results, ripgrep]
bot_visibility: partial
```

### What it looks like in a diff

A production change and a test change in one PR, where the test change moves the same
direction as the code. The new expected value is exactly what the code now returns. An
assertion that used to pin a value now checks something weaker.

### How to recognize it

Read each changed test line against its production change and ask whether the test changed
because the specification changed, or because the code did. A changed test is legitimate when
the requirement changed (the spec or ticket says so). It is a smell when the change makes the
old failure disappear.

### Likely intents

1. The requirement changed, and the test was updated first or alongside it (a legitimate
   change).
2. The test pinned an implementation detail that moved.
3. A regression the author did not want to chase, so the test was adjusted.
4. A flaky test was silenced.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Did the requirement change? | Read ticket and spec | `linked-work-item` |
| What did the test assert before, and why? | History of the test | `log-L`, `blame-C` |
| Does the changed test still fail on a plausible bug? | Reason about or run a mutation | `read-file`; local run for mutation tools |
| What does the skip or xfail point at? | Look for a reason string and a ticket | `read-file`, `ripgrep` |
| Did snapshot diffs change meaning or format? | Inspect the snapshot hunks | `read-file` |

### What not to spend review on

Test setup and fixtures unchanged by the PR.

### Checklist

The guide lists this under tests in AI-assisted PRs: "weakened assertions, new `skip` or
`xfail` markers, expected values copied from the output, or mocks of the code under test", and
asks for particularly close reading
([AI-generated code](../../Code-Review-Guide-and-Playbooks.md#ai-generated-and-ai-assisted-code)).
It is just as relevant to human PRs. The checks that follow from the operation:

- **Each assertion change traces to a requirement change.** The PR links the reason. "Behavior
  changed" is not the same as "spec changed".
- **The new assertion is at least as strong.** A swap from an exact value to a truthiness check
  loses information. Ask what wrong output would still pass.
- **No test is skipped without a ticket.** A new `skip` or `xfail` needs a reason string, a
  link and an owner. It is hiding a failure until it has all three.
- **Expected values come from the spec, not from the output.** A snapshot regenerated with `-u`
  records what the code does, not what it should do. Read the snapshot diff as a specification
  change.
- **No mock replaced the real behavior.** The code under test is not mocked, and mocks of
  collaborators return what the real ones return
  ([test code rules](../../Code-Review-Guide-and-Playbooks.md#test-code-itself-helpers-fixtures-and-fakes)).
- **Coverage is not shrinking.** Deleted tests have a stated reason, and their behavior is
  covered elsewhere.
- **The behavior change gets the review it would get without the test change**
  ([BEH-03](behavior.md#beh-03-conditional-or-boundary-change) for boundary shifts).

### How it combines with domain playbooks

It widens them. The production change is reviewed under its domain, with the knowledge that its
tests were edited, so the tests can't be used as evidence that the change is right.

### Red flags

- Tests edited and the production code changed in the same commit, with no test that fails on
  the new code and passes on the old.
- `xfail` / `skip` on the test covering the code the PR modifies.
- A mock for the function the test is named after.
- A snapshot diff that is larger than the production diff.

### Worked example

A PR changes `calculate_tax()` to round half-up instead of half-even. `test_tax_rounding` goes
from `assert calculate_tax(2.675) == Decimal("2.68")` to `assert calculate_tax(2.675) >=
Decimal("2.67")`. The review points out that the new assertion passes for both rounding modes,
so it no longer pins the rule. It asks for the exact expected value and a second case that
distinguishes half-up from half-even.

### ai-review-bot today

`pr-test-analyzer` looks for coverage gaps in the patch, and the weakened assertion is visible
as a changed line. The bot can't tell whether the requirement changed, because it has no
ticket, and it can't see what the test asserted before when the original side is dropped from a
budget-limited prompt (deletion-only hunks go first). `.snap` files count as generated in
`isGeneratedFile()`, so a snapshot rewrite sorts to the end of the prompt and is easily
cut or skipped. What it would need: the ticket, and both sides of each test edit.

### Eval seed

On a PR where an exact tax assertion becomes `>=` after a rounding-rule change, the review says
the assertion no longer distinguishes the rules and asks for an exact value.

## CMP-06: One-step column rename with dependent code

```yaml
id: CMP-06
name: One-step column rename with dependent code
family: composite
aliases: [rename column, change column type, drop column with code, expand/contract violation, big-bang schema change]
signals:
  - a migration with `op.alter_column(..., new_column_name=...)`, `RENAME COLUMN`, `ALTER COLUMN ... TYPE`, `DROP COLUMN`, `DROP TABLE`, or a Django `RenameField` / `AlterField` / `RemoveField`
  - model, query and serializer code changed to the new name in the same PR
  - a Prisma, Drizzle, TypeORM or Knex migration that renames or retypes a column, with query code changed in the same commit
  - no backfill job, no second migration, no mention of a deploy order
narrows_playbooks: false
escalates_with: [migration, data-write, public-api, critical-path]
guide_refs:
  - "#migrations-and-deployment-sequencing"
  - "#data-modeling-tables-relationships-and-domain-objects"
  - "#background-jobs-queues-and-events"
  - "#compatibility-hyrums-law"
tools: [read-file, ripgrep, lsp-references, linked-work-item, ci-results, module-graph]
bot_visibility: partial
```

### What it looks like in a diff

A migration file with a rename, retype or drop, plus code changes that use the new name. In
review it looks tidy: schema and code agree, and tests pass against a fresh database.

### How to recognize it

The migration contains a rename, type change or drop, and the same PR changes code that reads
or writes that column. The pair is the signal. Each half alone could be fine.

### Likely intents

1. A naming fix the author wanted done in one step.
2. A normal development workflow where deploys are assumed atomic.
3. Cleanup of a column that nothing is thought to read, which is a deletion claim
   ([deletion.md](deletion.md)) that needs checking.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Who reads and writes the column, now and at base? | References to the field, search for the raw name in SQL | `lsp-references`, `ripgrep` |
| Does anything outside the PR touch it? | Search other services, jobs, reports, analytics | `ripgrep`, `module-graph` |
| How does the deploy run? | Pipeline: migration first, code first, or together? | `read-file` on CI/CD config, `linked-work-item` |
| How big and hot is the table? | Row counts, locks | not available from the diff; the description should say |
| Is there a rollback plan? | Downgrade migration, data state | `read-file` |

### What not to spend review on

Whether the new name is nicer. Review the sequencing.

### Checklist

The guide gives the sequence (expand, write both, backfill, read new, contract) and says: "A PR
that renames a column, changes a type or drops anything in one step, alongside the code that
depends on it, is a finding"
([migrations](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)).
Mapped to this PR:

- **Which step is this?** The description says so and says what follows. A single PR that
  contains expand and contract is the violation.
- **Both versions of the code work against the schema in each deploy state.** During a
  rolling deploy old code runs against the new schema. If the old code selects the old column
  name, it errors until it is replaced.
- **Deploy order does not depend on luck.** If the migration and code must go in a specific
  order, the pipeline guarantees it.
- **Backfill is separate**, batched and resumable, and not inside the schema migration.
- **Other consumers are accounted for.** Workers, cron jobs, reporting tools, dashboards,
  BI exports, and other services often read the column by raw name. A rename that `lsp-references`
  passes still breaks them. Search all the repos you can.
- **Rollback works.** The downgrade restores the data, not only the name. A dropped column
  cannot be restored by a downgrade.
- **Locks are considered.** A type change or rename on a large table can block writes.

### How it combines with domain playbooks

It widens the migration and data-modeling playbooks to the full set, and it pulls in the
background-jobs playbook, since jobs in flight during the deploy hold old payloads.

### Red flags

- A migration and code change using the same new name, one PR, no flag.
- `DROP COLUMN` with no earlier "stop writing" release.
- A raw SQL or analytics query using the old name outside the repo.
- A downgrade that recreates the column empty.

### Worked example

An Alembic migration renames `orders.cust_id` to `customer_id`, and the ORM model and 9 queries
change to match. Tests pass. The review notes that during the rolling deploy old pods query
`cust_id` and fail, and that `reports/nightly.sql` and a worker in another repository read
`cust_id`. It proposes the sequence: add `customer_id`, write both, backfill, switch reads, then
drop `cust_id` a release later.

### ai-review-bot today

The migration path keyword (`migration`, `schema`) routes the PR to the complex tier, so it gets
the stronger model. The agents can read both halves of the PR. They can't see readers outside
the diff, the deploy order, or the table size. `security-sast` and the other Tier 1 agents are
not specialised for expand/contract. What it would need: a migration-aware prompt, and a
repository-wide search for the old column name.

### Eval seed

On a PR renaming a column in one migration with the dependent code, the review names the
expand/contract sequence and the old-code-during-deploy failure.

## CMP-07: Merge-commit noise from the base branch

```yaml
id: CMP-07
name: Merge-commit noise from the base branch
family: composite
aliases: [merge main into branch, noisy merge, wrong-base diff, accidental rebase churn, stale branch merge]
signals:
  - commits titled "Merge branch 'main' into ..." or "Merge remote-tracking branch"
  - files in the PR that the PR description does not mention, authored by other people in recent history
  - a diff that shrinks when computed against the merge base and not against the base branch tip
  - commit authors in the PR who are not the PR author
  - a file list that jumps after a push with no corresponding change by the author
narrows_playbooks: true
escalates_with: []
guide_refs:
  - "#size-the-change-before-reading-it"
  - "#review-locally-not-only-in-the-browser"
tools: [pr-files-api, read-file, log-L, blame-C, linked-work-item]
bot_visibility: partial
```

### What it looks like in a diff

GitHub's PR diff is computed against the merge base, so a clean merge of `main` into the branch
normally does not add files to the PR. Noise appears when the history is odd: the base branch
was force-pushed, the branch was merged the wrong way around, a rebase conflict was resolved by
re-adding other people's changes, or a merge commit carries conflict-resolution edits that
belong to neither side.

### How to recognize it

Compare the PR's file list with what the description and the author's own commits explain. Files
nobody on the PR touched, or hunks that match changes already on the base branch, are noise.
Inspect each merge commit for resolution edits: a merge with conflict resolutions has lines that
appear in neither parent.

### Likely intents

1. Keep the branch up to date with `main`, and nothing more (harmless when the history is
   clean).
2. A conflict resolution, which is real code written inside a merge commit.
3. A mistaken base or a bad rebase that dragged other work in.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Which files did the author change? | Per-commit view, filtered to the author's commits | `pr-files-api` |
| Do any hunks already exist on the base branch? | Compare to the base branch tip | `read-file` at base |
| What did the merge commit resolve? | Inspect the combined diff of the merge | `log-L`, `blame-C` |
| Is the base branch the right one? | Check the PR target | `linked-work-item` |

### What not to spend review on

Changes that arrived from the base branch. They were reviewed in their own PRs.

### Checklist

- **The PR's intended scope matches its files.** Files outside it are asked about, not
  reviewed.
- **Conflict resolutions are reviewed as new code.** They are authored in the merge and have
  had no other review. A resolution that silently takes one side drops the other side's change.
- **No other people's work was reverted by resolution.** Compare the resolved file against both
  parents.
- **Rebase if the history is noisy.** A branch that has base-branch changes folded into its own
  commits should be rebased onto the base, so the diff is the author's work.
- **A force-push is explained** when it changes already-reviewed commits.
- **Tests were re-run after the merge.** A merge of two green branches can be red.

### How it combines with domain playbooks

It narrows them for base-branch content and widens them for the conflict resolution, which is
code like any other.

### Red flags

- A large merge commit with resolutions in security-sensitive files.
- A PR whose diff includes changes the base already has.
- Another author's work reverted in the PR's final state.
- A tests-green claim that predates the last merge.

### Worked example

A PR titled "Add export button" lists `api/auth.py` as changed. The author did not touch it.
The file's diff reverts a fix merged to `main` yesterday: the author's merge resolved a
conflict by taking their side. The review flags the revert and asks for a rebase.

### ai-review-bot today

The bot reviews the diff GitHub reports for the PR, which excludes clean base-branch content.
It does not look at individual commits or merge commits, so conflict resolutions are reviewed
only if they show up in the final patch, and with no sign that they were authored in a merge.
`ai-review watch` and the incremental mode review the delta since the bot's last review, which
can include base-branch changes pulled in by a merge. What it would need: per-commit data and
merge-commit awareness.

### Eval seed

On a PR where a merge resolution reverts a recent base-branch fix in an unrelated file, the
review flags the revert and does not treat the file as the author's feature.

## CMP-08: AI-generated bulk change

```yaml
id: CMP-08
name: AI-generated bulk change
family: composite
aliases: [agent-written PR, LLM refactor, AI-assisted large diff, generated feature, vibe-coded change]
signals:
  - a large diff across many files in a short time, with a uniformly polished style and extensive docstrings or comments restating the code
  - 'a commit trailer or description crediting an AI tool (Co-Authored-By: Claude, "generated with", Copilot, Cursor)'
  - helpers, options and fallback branches that the ticket doesn't ask for
  - '`try`/`except` or `try`/`catch` wrappers and `None` checks at every call'
  - a new dependency or an API call to a library function that does not exist in the pinned version
  - tests that assert the implementation's own output, with mocks of the code under test
narrows_playbooks: false
escalates_with: [public-api, trust-boundary, auth, data-write, money, critical-path]
guide_refs:
  - "#ai-generated-and-ai-assisted-code"
  - "#reviewing-code-against-its-spec"
  - "#simplicity-and-scope"
  - "#new-dependencies"
  - "#tests-levels-coverage-gaps-and-tdd"
  - "#size-the-change-before-reading-it"
tools: [linked-work-item, ripgrep, workspace-symbols, lsp-definition, read-file, ci-results, agent-instructions]
bot_visibility: partial
```

### What it looks like in a diff

Volume, with a consistent surface. Many files change at once, comments narrate the code,
docstrings repeat the type hints, and each function guards against inputs the caller can't
produce. Some pieces duplicate helpers that already exist in the repo.

### How to recognize it

Trailers and descriptions often say so. Without them, rely on the characteristic failures
listed in the guide: scope beyond the spec, plausible but wrong APIs, invented packages,
defensive noise, narrating comments, duplicates of existing code, inconsistency with the
codebase, tests bent to pass, and unexplained removals. The guide is clear that the standard
is the same as for any code and the author owns every line.

### Likely intents

1. A real feature or refactor built with an assistant, where the author read and curated the
   result.
2. A speculative or exploratory output submitted without being read.
3. A bulk mechanical job done by an agent instead of a codemod. Compare with
   [MEC-06](mechanical.md#mec-06-codemod-or-bulk-find-and-replace): an agent's sweep has no
   single rule, so each hunk may be different.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What was asked for? | Ticket and spec, to measure scope | `linked-work-item` |
| Do the called APIs exist at the pinned version? | Go to Definition into the installed package, or read the docs | `lsp-definition`, `read-file` |
| Is it a duplicate of something existing? | Search the repo by behavior and name | `workspace-symbols`, `ripgrep` |
| Are new packages real and needed? | Registry check, existing alternatives | `read-file` on manifest; `ripgrep` for current usage |
| What conventions does the repo set? | Instruction files, existing patterns | `agent-instructions` |
| Do tests test behavior? | Read them as a spec | `read-file`, `ci-results` |

### What not to spend review on

Style that the repo's formatter and linter own. Comments that narrate are asked to be removed
once, not rewritten one by one.

### Checklist

The guide has the list in
[AI-generated and AI-assisted code](../../Code-Review-Guide-and-Playbooks.md#ai-generated-and-ai-assisted-code).
Applied to a bulk change:

- **Scope is compared to the spec, strictly.** Extras are removed, not only noted.
- **Every external call is verified to exist.** A plausible method name that isn't in the pinned
  version is the most expensive thing to miss, because the code reads as correct.
- **Every new import is checked** against the dependencies playbook. A name suggested by a
  model may not exist or may be a malicious package registered under that name.
- **Defensive code is questioned**: what failure does each `try` guard, and who sees it
  ([BEH-04](behavior.md#beh-04-error-handling-change))?
- **Duplicates of existing code are found** and replaced by reuse.
- **Tests are read for being bent to pass**
  ([CMP-05](#cmp-05-tests-changed-to-match-new-behavior)), because an agent that fails a test
  is likely to edit it.
- **Unexplained removals get Chesterton's Fence.** Deleted guards and retries need a reason
  ([deletion.md](deletion.md)).
- **The author can explain any part.** If asked, they can say why a function exists. The first
  comment can be the request for a split into reviewable pieces.
- **Size is managed.** Ask for smaller PRs, since a generated diff arrives faster than a person
  can read it.

### How it combines with domain playbooks

It widens them. This is the case where the reviewer can't assume the author considered the
domain, so the full playbook for each touched domain applies, along with the guide's
AI-specific list.

### Red flags

- A call to a function nobody can find in the library's docs.
- A new package with few downloads and a name close to a popular one.
- Tests that only pass because the assertion is on what the code returned.
- Removed guards with no explanation.
- A description longer than the diff's actual change.

### Worked example

A 40-file PR "Add retry support to all clients" has a new `RetryPolicy` class, three config
options, and `try`/`except Exception` wrappers around 22 calls. The ticket asked for retries
on one client. The review asks to cut the PR to that client, notes that `httpx.Client(retries=3)`
is not a real argument (retry is configured on the transport), and that the new tests mock the
client they claim to test.

### ai-review-bot today

The bot has no signal that a change is AI-written, and its agents review everything with the
same thoroughness. It cannot verify that an API exists in the pinned version, search for
duplicates, or check a package name against a registry, which are the characteristic failures.
`classifyTier()` routes by size and path, so a large AI-written PR becomes complex by line
count only. What it would need: dependency and import verification against the installed
packages, and a search for existing helpers.

### Eval seed

On a PR that calls a library argument that does not exist in the pinned version and adds a
broad `except` around it, the review flags the nonexistent argument.
