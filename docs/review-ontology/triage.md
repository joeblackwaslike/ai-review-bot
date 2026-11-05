# Triage: judging a PR's complexity

Today the bot sizes a PR by counting changed lines of text and matching a few path substrings.
That decides the model, the effort, and (through [tier2.ts](../../src/tier2.ts)) which extra
agents run. A senior reviewer sizes a PR differently. They look at what the files are, what the
code in them does, what was done to it, and what depends on it, and they read the description
before the diff. This file lays out that judgment as dimensions a program can measure, shows how
the dimensions could combine into a tier and an agent set, and says what the hosted bot would
need to compute each one.

Everything in the scoring section is a proposal. The numbers are placeholders to be validated by
experiment (see [How to validate](#how-to-validate)), not tuned values.

The operation side of the model (what was done to the code) lives in
[operations/](operations/relocation.md). The domain side (what the code is) lives in
[domains.md](domains.md), with the checklists in the
[guide](../Code-Review-Guide-and-Playbooks.md#part-2-code-review-playbooks). The tools that
measure these dimensions are defined in [context-building.md](context-building.md).

## Why size fails

Two PRs, one count each.

**Twenty files, two lines each.** A symbol rename, say `userId` to `accountId`, applied by an
editor's rename refactor. It is 40 changed lines in 20 files. Every changed line differs by one
token. A senior reviewer spends a minute: confirm it is a pure rename
([REL-03](operations/relocation.md#rel-03-symbol-renamed-in-place)), check for stragglers in
strings and docs, and check that no serialized name changed. A line-count triage sees 20 files
and treats it as ordinary work. If it is large enough it also pulls in `architect-review`.

**One file, 40 lines.** A change to the authentication dependency that every FastAPI route
declares with `Depends(get_current_user)`, or the Express middleware that every router mounts.
It changes how a token is validated. A senior reviewer reads this as the most expensive PR of the
week. Every endpoint in the service inherits the change, a mistake is a security incident, and
the guide's [authentication and authorization](../Code-Review-Guide-and-Playbooks.md#authentication-and-authorization)
and [trust boundary](../Code-Review-Guide-and-Playbooks.md#least-privilege-and-trust-boundaries)
sections apply to every line. A line-count triage sees 40 lines.

The first PR should get the cheapest review that still checks the rename's blast radius. The
second should get the most careful one the bot can run. A line count orders them the wrong way
round.

### What `classifyTier()` does

From [src/router.ts](../../src/router.ts), in order:

```ts
if (labels.includes("deep-review")) return "deep";
if (filePaths.some(isSensitivePath)) return "complex";
if (additions + deletions > 500) return "complex";
if (totalLines < 20 && filePaths.every(isDocFile)) return "trivial";
return "normal";
```

The tier then picks one model and effort for the whole review. Every agent for that provider
shares the selection (`routeModel()` is called once in `src/review.ts`).

| Rule | What it gets wrong |
| --- | --- |
| `deep-review` label | Correct when someone applies it, but nothing does so automatically. The replay harness doesn't record labels, so replays can never exercise it. |
| Sensitive path substring (`auth`, `crypto`, `jwt`, `password`, `secret`, `/db/`, `database`, `migration`, `schema`) | Matches names, not roles. `author_bio.py`, `docs/authentication.md` and `tests/fixtures/secret_santa.json` all count as sensitive. It misses the auth dependency when it lives in `deps.py`, `security.py`, `middleware.ts` or `guards/`. `schema` fires on every Pydantic request model, which sometimes matters and often doesn't. This check also runs before the docs check, so a one-line typo fix in an auth doc is `complex`. |
| More than 500 added plus deleted lines | Counts generated files, lockfiles, snapshots and relocated code at full weight. A pnpm lockfile bump for one dependency is `complex`. A 45-line change to a hot path in 3 files is `normal`. |
| Under 20 lines and every file is `.md`, `.txt`, `.rst` or `.mdx` | Treats `requirements.txt` as documentation. Treats `AGENTS.md`, `CLAUDE.md` and `skills/*.md`, which are instructions to agents and change behavior, as documentation. Both get the cheapest model. An empty file list is also vacuously "all docs". |
| Everything else is `normal` | One bucket for a 30-line utility tweak and a 450-line new endpoint with its model and migration. |

Three of the four rules look at path text. The fourth looks at a number that mixes real change
with churn. None looks at file content, what the code does, or how much of the diff is code that
merely moved.

### What the Tier 2 detectors add

[src/tier2.ts](../../src/tier2.ts) picks the optional agents with the same kind of signal.

| Detector | Signal | Failure mode |
| --- | --- | --- |
| `type-design-analyzer` | Typed extension changed, and the patch contains a regex hit such as `class `, `interface `, `Protocol`, `generic` | Any added line of prose containing "Protocol" or "generic" counts. A class that moved unchanged counts. |
| `comment-analyzer` | Any `.md`/`.mdx`/`.rst`/`.txt` file in the PR, or 5 or more added comment-looking lines | One docs file in a 40-file code PR switches it on. A `#` in a shell script or a `//` in a URL looks like a comment. |
| `security-auditor` | Path contains one of about 30 substrings (`user`, `role`, `ci`, `token`, `deploy`, ...), or two keywords in the title and body, or a patch regex such as `process.env.` | `ci` matches `decimal`, `precision` and `decision`. `user` matches every user model, though that is sometimes right. A real auth change in a file named `deps.py` is missed unless the patch has a keyword. |
| `architect-review` | `architecture` or `breaking-change` label, 3 or more boundary-looking paths, or 300 lines across 10 files | Rename churn and generated files satisfy the size rule. A real boundary change in 2 files doesn't. |

## Dimensions

Each dimension below says what it captures, how to measure it from a diff plus PR metadata, and
what it costs. "Hosted" means the webhook path with only the GitHub API; "checkout" means a
local clone; "language server" means a running LSP over that clone (see
[context-building.md](context-building.md#feasibility)).

### 1. File kind

What the file is for, before reading it. This is the first cut of Joe's list in
[00-origin.md](00-origin.md#1-triaging-the-complexity-of-a-pr).

| Kind | How to tell | Review weight |
| --- | --- | --- |
| Binary | No `patch` in the files API response; extension check | Near zero for content. Check size, provenance and whether it belongs in git at all. |
| Generated | Path and header patterns; the bot already has `isGeneratedFile()` in `src/diff-pack.ts` | Near zero. Review the source it was generated from, and whether the generator ran. |
| Lockfile | `pnpm-lock.yaml`, `package-lock.json`, `uv.lock`, `poetry.lock`, `Cargo.lock`, `bun.lock` | Low for lines. High for the dependency set it implies: read the manifest diff and the [new-dependencies](../Code-Review-Guide-and-Playbooks.md#new-dependencies) playbook, not the lock lines. |
| Docs | `.md`, `.mdx`, `.rst`, `docs/` | Low, except docs that are executable: `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, prompt files, OpenAPI descriptions that generate clients. |
| Spec or plan | Paths such as `docs/**/specs/`, `docs/**/plans/`, ADR directories; headings like "Requirements" | Review against the [design specs](../Code-Review-Guide-and-Playbooks.md#design-specs-and-plans) playbook. Lines are cheap to read, wrong decisions are expensive to fix. |
| Config | `.json`, `.yaml`, `.toml`, `.ini`, `.env*` outside the other kinds | Small diffs, large effects. See [configuration files](../Code-Review-Guide-and-Playbooks.md#configuration-files). |
| IaC and build | `Dockerfile`, `*.tf`, Helm charts, Kubernetes manifests (a YAML file with top-level `apiVersion` and `kind`), CI workflow YAML | High per line. Blast radius is the environment, not the module. |
| Shell | `.sh`, `.bash`, a `#!/bin/sh` first line, `Makefile` | High per line. Quoting, `set -e` and unset variables are the usual defects. |
| Code | Recognized source extensions | Depends on role (dimension 2). |
| Tests | `test_*.py`, `*_test.py`, `*.test.ts`, `*.spec.ts`, `__tests__/`, `tests/`, `conftest.py` | Depends on whether they are tests, or helpers and fixtures (dimension 2). |

*Cost.* Path and extension rules are free on the hosted path. Content sniffing (shebang,
`apiVersion:`, generator headers) needs the patch text, which the bot already has, or the file at
head, which it doesn't. The value of this dimension is mostly in what it removes: binary,
generated and lock content stops counting toward the size of the review.

### 2. Code role

For code files, what part of the system this is. The role decides which failure modes matter. The
list follows Joe's questions, and each role has signals in both languages.

| Role | Python signals | TypeScript signals | What it implies |
| --- | --- | --- | --- |
| Utility library | Module of top-level `def`s, no I/O imports; `utils/`, `helpers/`, `lib/` | Module of `export function`s; `utils.ts`, `lib/` | High fan-in is typical. Behavior changes ripple. See [compatibility](../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law). |
| Domain model or ORM | `class X(Base)`, `mapped_column`, `models.Model`, Pydantic `BaseModel` with `table` semantics | Drizzle `pgTable`, Prisma `schema.prisma`, TypeORM `@Entity` | Data shape. See [data modeling](../Code-Review-Guide-and-Playbooks.md#data-modeling-tables-relationships-and-domain-objects) and migrations. |
| Controller, route or view | `@router.get`, `APIRouter`, Flask `@app.route`, Django `urls.py`/views | Express `router.get`, Next.js `app/**/route.ts`, NestJS `@Controller` | Public surface and input validation. See [new endpoints](../Code-Review-Guide-and-Playbooks.md#new-api-endpoints). |
| Auth component | Imports of `jwt`, `passlib`, `authlib`; `Depends(get_current_user)`; `OAuth2PasswordBearer` | Imports of `jsonwebtoken`, `jose`, `passport`, `next-auth`, `better-auth`; middleware that sets a user | Trust boundary. See [authentication and authorization](../Code-Review-Guide-and-Playbooks.md#authentication-and-authorization). |
| Job or consumer | `@shared_task`, `@celery.task`, RQ/arq functions, queue handlers | BullMQ `new Worker(`, SQS/Lambda handlers, cron entry points | Retries, idempotency, ordering. See [background jobs](../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events). |
| Migration | `alembic/versions/`, `op.add_column`, Django `migrations/` | `prisma/migrations/`, drizzle `meta/`, knex `migrations/` | Deploy sequencing and locks. See [migrations](../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing). |
| Test helper | `conftest.py`, `fixtures/`, factories | `testing.ts`, `test-utils`, `__mocks__/` | Used by many tests, so a change moves many results. See [test code itself](../Code-Review-Guide-and-Playbooks.md#test-code-itself-helpers-fixtures-and-fakes). |
| Entry point or wiring | `__main__.py`, app factory, `main.ts`, DI container | Same | Small diffs with startup effects. |

*Cost.* Path and import-line rules work from the diff alone, but only if the import lines are in
the hunk. A 3-line change inside `get_current_user()` doesn't show the `import jwt` at the top of
the file. A hosted fix is to fetch the file at head with the contents API (one call per
changed file, 1 MB cap on full features). A checkout does this for free. `file-outline` gives the
class and function list per file for the cost of a parse.

### 3. Operation mix

What was done to the code, as a share of the diff. The operation families are
[relocation](operations/relocation.md), [deletion](operations/deletion.md),
[interface](operations/interface.md), [behavior](operations/behavior.md),
[mechanical](operations/mechanical.md) and [composite](operations/composite.md). A diff is rarely
one operation. The useful output is a partition of the changed lines into operation classes, with
a weight for each class (dimension 6 covers the largest discount).

*How to measure.* Relocation: moved-block detection (`color-moved`, or hashing normalized
removed lines and matching them to added ones). Mechanical: whitespace-only and import-only hunks,
single-token swaps. Behavior: whatever remains after the others are subtracted.

*Cost.* Block matching on patch text is linear in patch size and needs no repository. It also
covers the case Joe describes, where the deleted and added halves sit far apart in the file list.
Interface detection (a signature changed, a field renamed) needs either the AST of both sides or a
language-aware regex on the patch.

### 4. Domains hit

Which playbooks apply to the changed code. [domains.md](domains.md) is the catalog. Domains come
from file kind, code role, and the content of the changed lines (a SQL string, a `Bearer` header,
a `subprocess` call). Domains are what pick agents (see the mapping below) and what raise the
floor of the tier (auth, money, migration, trust boundary).

*Cost.* Free from roles plus a regex pass over the patch. The noise level of the regexes is the
risk, which tier2.ts already shows. Prefer role over keyword where both are available.

### 5. Blast radius

How many places depend on what changed. This is the dimension that tells the 20-file rename from
the single auth dependency.

*How to measure.* For each changed exported symbol, count distinct referencing files:

- with a language server, `lsp-references` at the base commit (see the
  [tool reference](context-building.md#tool-reference));
- with an import graph, the in-degree of the changed module (`module-graph`);
- with neither, a `ripgrep` count of the symbol name, which overcounts common names.

Bucket the result (0, 1 to 3, 4 to 20, more than 20) instead of using the raw count. A change to a
symbol with no references outside its file is local, whatever its line count.

*Cost.* One LSP request per changed exported symbol. Cap the number of symbols looked up per PR,
and treat the capped remainder as "unknown, assume high". The hosted bot can't do this today (see
the last section).

### 6. Trust boundary

Whether untrusted input crosses the changed code, or whether the code decides who may do what.
Inputs are the role (route handler, auth component), the content (request parsing, a deserializer,
`eval`, a shell call with interpolated input, an `Authorization` header read) and the entry
points (public router versus internal job). Both Joe's origin notes and the
[guide](../Code-Review-Guide-and-Playbooks.md#least-privilege-and-trust-boundaries) treat this as
the reason a second checklist applies on top of everything else.

*Cost.* Same as roles. A call graph from the changed function up to a public entry point
(`lsp-call-hierarchy`) turns "probably reachable" into "reachable from `POST /v1/webhooks`".

### 7. Novel versus relocated code

The share of added lines that are new, as opposed to code that already existed elsewhere. A
relocated line was reviewed when it was written. Count it at roughly zero and spend the budget on
the places the move could have broken. See [REL-01](operations/relocation.md#rel-01-function-or-class-moved-between-files).

*How to measure.* `color-moved` marks lines moved between files, and `blame-C` attributes them to
their original commit. On the hosted path, hash each removed line after normalizing whitespace,
then look for runs of 3 or more consecutive added lines with the same hashes. Whole-file renames
come from `pr-files-api` (`status: "renamed"`, `previous_filename`); heavily edited renames below
git's 50 percent similarity default appear as a delete plus an add and need the block matching
above.

*Cost.* Block matching on the patch is cheap and needs no checkout. Its limits are that it matches
only lines present in the diff (so a deletion-only hunk must not be dropped before this runs) and
that a renamed symbol changes lines inside the block.

### 8. Test coupling

Whether behavior changes come with test changes. A behavior change with no test change is a
finding on its own ([guide](../Code-Review-Guide-and-Playbooks.md#tests-make-it-work-provably)).
It also affects confidence: with no test change, a reviewer can't use the tests to learn what the
author meant.

*How to measure.* From the file list: changed source files with no changed file matching their
test naming convention (`test_<module>.py`, `<module>.test.ts`). With a checkout:
`lsp-references` filtered to test paths. Report the ratio of changed behavior lines to changed test
lines, and whether any test file imports a changed symbol.

*Cost.* Free from the file list, cheap with references.

### 9. Stated intent

What the author says the PR is for. The guide is direct about this: restate the intent in one
sentence before opening the diff, and if there is none, [the first comment is a question](../Code-Review-Guide-and-Playbooks.md#size-the-change-before-reading-it).

*How to measure.* Parse the PR body against the
[description template](../Code-Review-Guide-and-Playbooks.md#appendix-pull-request-description-template).
Score the presence of each field: what and why, spec or ticket link, requirements table, out of
scope, public surface changes, data and migrations, rollout, how to review. Resolve closing
references (`Closes #123`) with the GitHub API to fetch the linked issue (`linked-work-item`).
An empty body, or one that restates the title, is a signal in itself.

Missing intent does not change the tier. It caps what the bot may assert (it cannot say "this
contradicts the spec" with no spec) and changes the first output, which becomes a question. A
stated intent that conflicts with the diff is a finding: "no functional change" on a diff that
changes a comparison, for example.

*Cost.* The body and title come with the webhook payload. Fetching the linked issue is one API
call.

## How the dimensions combine

### Outputs

Three decisions, in this order:

1. **Tier** (`trivial`, `normal`, `complex`, `deep`), which today selects model and effort.
2. **Agent set**, which of the Tier 1 and Tier 2 agents run.
3. **Model and effort per agent.** Today one selection covers every agent in the review.

### Scoring sketch

This is a sketch to make the proposal concrete. Every weight below is a guess.

**Step 1: effective review mass.** Replace the changed-line count with a weighted one. For each
changed file, partition its changed lines into classes and multiply by class weights:

```text
mass = sum over files of
         ( novel_lines    * w_kind * w_role
         + relocated_lines * 0.05
         + mechanical_lines * 0.1 )
       * w_radius
```

with `w_kind` of 0 for binary, generated and lock content, about 0.3 for prose docs, 1.0 for
code, and 1.5 for IaC and shell; `w_role` of 1.0 by default, higher for auth, migration and
controller roles; `w_radius` of 1.0 for local changes rising to about 2.0 for symbols with more
than 20 referencing files.

**Step 2: mass to a base tier.** Bands such as under 30 trivial, 30 to 300 normal, 300 to 800
complex, above 800 deep-or-split. These are the bands most likely to need tuning.

**Step 3: risk floors.** Floors apply regardless of mass:

| Condition | Floor |
| --- | --- |
| Auth component or token handling changed | `deep` |
| Trust boundary crossed by a changed route or parser | `complex` |
| Migration or other data-write change | `complex` |
| Money or entitlement logic | `complex` |
| Public API surface changed (interface family) | `complex` |
| Concurrency primitives or retry logic changed | `complex` |
| Two or more of the above | one tier up, capped at `deep` |

**Step 4: tier is the higher of the base tier and the floor.**

**Step 5: agents from domains.** The Tier 1 set is not run unconditionally. Each agent is tied to
the domains it is good at:

| Agent | Runs when |
| --- | --- |
| `code-reviewer` | Any novel behavior lines |
| `silent-failure-hunter` | Novel behavior lines in code with I/O, retries, or error handling; job, route and client roles |
| `pr-test-analyzer` | Behavior lines present, or test files changed |
| `security-sast` | Trust boundary or auth domain; input parsing; shell, SQL or file access in novel lines |
| `security-auditor` (Tier 2) | Auth, money or secrets domain, replacing the substring check |
| `code-review-and-quality` (advisory) | `normal` and above, novel lines at least a threshold |
| `architect-review` (advisory) | Interface or composite operations, restructures, new modules, high blast radius |
| `type-design-analyzer` (Tier 2) | New or changed type definitions in the novel lines, not moved ones |
| `comment-analyzer` (Tier 2) | Docs-kind files with prose changes, or novel docstring changes |

A `trivial` PR runs one agent. A pure relocation runs the reference and mock checks rather than
the logic agents, and the checks come from the operation entry.

**Step 6: model and effort per agent.** Match effort to what the agent needs reasoning for:
`security-sast` and `security-auditor` take the tier's top effort whenever they run, and
`comment-analyzer` and `pr-test-analyzer` on a non-risky PR take one step lower than the tier. The
existing constraint stays: the `deep` tier is capped at `high` effort because `xhigh` can outlast
the 210-second agent deadline on Vercel Hobby (comment in `src/router.ts`).

### Worked table

Five hypothetical PRs. "Today" is what `classifyTier()` and the Tier 2 detectors do. "Proposed" is
the sketch above. The numbers are illustrative.

| PR | Today | Mass inputs | Proposed tier | Proposed agents |
| --- | --- | --- | --- | --- |
| A. `userId` to `accountId`, 20 files, 2 lines each, no serialized names | `normal`; `architect-review` stays off (40 lines) | 40 mechanical lines at 0.1 = 4; blast radius high but the change is a verified rename | `trivial` plus a straggler search | `code-reviewer` at low effort, plus the reference and string-search checks from REL-03. If a response type's field changed, the interface family applies and the floor rises to `complex`. |
| B. 40-line change to `get_current_user`, 3 files | `normal` unless the path contains `auth`; `security-auditor` only if the path or patch matches | 40 novel lines, auth role, fan-in over 20 | `deep` (auth floor) | `code-reviewer`, `security-sast`, `security-auditor`, `silent-failure-hunter`, `pr-test-analyzer`; `architect-review` for the blast radius. Security agents at top effort. |
| C. Directory restructure, 180 renamed files plus one changed default | `complex` (over 500 lines) with truncated diff | About 5,000 relocated lines at 0.05 = 250, one novel config line | `normal`, with the mixed-operation flag (see design-first mode) | `code-reviewer` on the changed default, `architect-review` on the new layout; a rename-aware pass collapses 180 pure renames to one line each. |
| D. New endpoint, ORM model and migration, 350 lines | `complex` (migration path) | Controller, model and migration roles; trust boundary; data write | `complex` | All Tier 1, plus `security-auditor` and `architect-review`. Playbooks for endpoints, validation, data modeling and migrations. Eligible for design-first. |
| E. Dependency bump: `package.json` plus a 2,000-line lockfile diff | `complex` (over 500 lines); lockfile shown at full weight | Lock lines at weight 0; manifest lines at 1.0 | `normal`, rising to `complex` if the dependency is new rather than bumped | `code-reviewer` on the manifest and any code changes, plus the new-dependencies playbook. `security-sast` only when a new package is introduced. |

Against today's behavior, PR A drops a tier, PR B rises two, PR C stops being a truncated diff,
and PR E stops being a false "complex". Each of those is a testable claim.

### How to validate

None of these weights come from data. The existing replay harness (`ai-review replay`) records
rounds with labeled findings, which makes the following experiments cheap:

1. Compute the proposed tier and agent set for every recorded PR, and compare with what the old
   triage did. Count how many human-labeled true findings came from agents the new set would drop.
2. For PRs where the old tier was `complex` only because of line count or a path substring, check
   whether lowering the tier loses any confirmed finding.
3. Build a held-out set of PRs that are small but dangerous (auth dependency changes, one-line guard
   removals) and check that the floors catch all of them.
4. Track cost per review and wall-clock time per agent set against the 210-second agent budget.

A weight stays only if confirmed-finding recall holds and cost goes down.

## Design-first mode

The guide says a large change can be [reviewed in two rounds](../Code-Review-Guide-and-Playbooks.md#review-in-the-order-of-make-it-work-make-it-right-make-it-fast):
scope and design first, then everything else once those are settled. It also says that
[past a few hundred changed lines](../Code-Review-Guide-and-Playbooks.md#size-the-change-before-reading-it)
review quality drops and the right move is to ask for a split along a seam (refactor vs. behavior
change, schema vs. code, new module vs. call-site migration).

The proposal is a mode the triage can select, not a tier.

**When it triggers.** Effective mass above the split band, or (more useful) a diff whose changed
lines fall into two or more independent operation classes that could ship separately: a
restructure plus a behavior change (REL-08 hiding a behavior change, the composite family), schema
plus code, a refactor plus a feature. Mass alone doesn't trigger it for a pure mechanical change,
since splitting a rename into pieces helps nobody.

**What round 1 reviews.** Only the things that decide scope and design:

- the stated intent, and whether the diff matches it
- the file list grouped by kind, role and operation class, with the relocated share
- the new public surface (names, endpoints, config keys, migrations, events)
- module-graph changes (new dependencies between modules, cycles)
- the seams along which the PR could split

**What round 1 posts.** One comment-level review with no line comments: the proposed split, or the
design concern, or a question about intent. It doesn't approve and it doesn't request changes on
line-level matters, since the code may be restructured. If the author answers or splits, the next
push gets the full review at the tier the new, smaller diff earns.

**What it costs.** One cheap pass on metadata and the file list instead of the full agent set on a
truncated diff. At the 200,000-character diff budget, `packDiff()` already omits files from a very
large PR. A design-first round is a better use of that situation than reviewing the fragment that
fits.

**What it must not do.** Block a PR that is large only because most of it is relocated or
generated. The relocated share is the guard.

## ai-review-bot today

What each dimension would need that the hosted path doesn't have. The hosted path gives every agent
the PR metadata and the serialized diff, with right-side line numbers. `classifyTier()` receives
only `additions`, `deletions`, `filePaths` and `labels`; Tier 2 detectors also get the title, body
and concatenated patch text.

| Dimension | Available on the hosted path today | Missing |
| --- | --- | --- |
| File kind | Paths, extensions, the patch text, `isGeneratedFile()` in `diff-pack.ts`; no `patch` for binaries | A kind classifier that feeds `classifyTier()`; today only the docs and sensitive-path checks use kind |
| Code role | Paths and the patch text | Import lines and decorators outside the hunk. Fix: fetch each changed file at head through the contents API, or `file-outline` in a checkout |
| Operation mix | Patch text | Moved-block matching, mechanical-hunk detection, interface-change detection. All can run on the patch with no repository |
| Domains hit | Paths, title and body, patch regexes (tier2.ts) | Role-based domain assignment instead of substrings |
| Blast radius | Nothing | References or an import graph at the base commit. Needs a checkout and a language server, or a precomputed index |
| Trust boundary | Path and keyword regexes | A call graph to an entry point |
| Novel versus relocated | Per-file `previous_filename` for whole-file renames (used in `src/ledger/retarget.ts` to carry findings, not in triage); deletion-only hunks are dropped when over budget | Block matching before packing, so the deletion half survives long enough to be matched |
| Test coupling | The file list | A mapping from source to test files, then references |
| Stated intent | PR title and body in the payload | Template-field parsing, and the linked issue fetch |

Two changes are cheap and don't need a repository: classify file kinds and compute relocated
lines from the patch before `packDiff()` runs, then feed both to `classifyTier()`. The rest need
some form of checkout, which the local CLI has and the hosted path doesn't. The local CLI runs in a
checkout today but doesn't use it for navigation. How a reviewer agent would call these tools, and
the contracts for them, belong in [reviewer-tools.md](reviewer-tools.md).
