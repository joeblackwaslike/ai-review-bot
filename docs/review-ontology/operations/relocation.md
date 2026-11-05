# Relocation operations

Code that already existed now lives somewhere else, under the same name or a new one. The
reviewer's job changes completely once a relocation is recognized. Code that moved unchanged
was reviewed when it was written, so review effort goes to two other places. One is what the
move could have broken: references, imports, mocks, config strings, routes and registered
names. The other is whether the new location is better, judged by the guide's cohesion rules.

The direction of a move is usually the verdict. Code moving *toward* its callers is the
guide's [cohesion rule](../../Code-Review-Guide-and-Playbooks.md#single-responsibility-and-cohesion)
at work. Code moving *away* from its only caller into a shared module is
[scattering](../../Code-Review-Guide-and-Playbooks.md#scattering-cohesive-code-for-reuse).

## REL-01: Function or class moved between files

```yaml
id: REL-01
name: Function or class moved between files
family: relocation
aliases: [relocate, move symbol, move-then-rename]
signals:
  - a deleted block in one file and an added block in another with near-identical bodies
  - the same symbol name removed from one module and defined in another, or a renamed symbol with the same body
  - import lines changing from the old module to the new one at call sites
  - the old file deleted or left nearly empty
narrows_playbooks: true
escalates_with: [public-api, trust-boundary, auth]
guide_refs:
  - "#review-locally-not-only-in-the-browser"
  - "#single-responsibility-and-cohesion"
  - "#scattering-cohesive-code-for-reuse"
  - "#compatibility-hyrums-law"
  - "#test-code-itself-helpers-fixtures-and-fakes"
tools: [color-moved, blame-C, log-L, lsp-references, ripgrep, tree-sitter-diff, linked-work-item]
bot_visibility: none
```

### What it looks like in a diff

A function or class disappears from `a.py` (or `a.ts`) and an almost identical one appears in
`b.py`. The two hunks are often far apart in the PR's file list, because files are sorted by
path. Call sites change only their import line: `from pkg.a import parse_invoice` becomes
`from pkg.b import parse_invoice`, or `import { parseInvoice } from "./a.js"` becomes
`from "./b.js"`. If the symbol was renamed on the way, the call sites change the name too, and
the body differs only in that name and maybe its docstring.

### How to recognize it

Compare the removed block with the added block, ignoring whitespace and the symbol's own
name. A near-identical body is a move. `git diff --color-moved` marks moved lines directly,
and `git blame -C` on the new file attributes the moved lines to their original commit in the
old file.

Look-alikes to rule out:

- **A copy, not a move.** The old definition is still there. That's duplication, and the
  guide's DRY rules apply (is it the same knowledge?).
- **Delete plus unrelated new code.** The bodies differ in logic, not just in names. Treat
  them as a deletion ([deletion.md](deletion.md)) and new behavior ([behavior.md](behavior.md)).
- **Move plus modify.** The bodies match except for a few logic lines. That's
  [REL-10](#rel-10-move-plus-modify), and the changed lines get a full review.
- **Whole-file rename.** Every line moved with the file. That's [REL-02](#rel-02-file-moved-or-renamed).

### Likely intents

1. **Cohesion.** Every caller lives in the destination file, so the move removes an import
   and puts the code next to its only user. Confirm with references at the base commit: if
   all of them came from the destination file, this is the intent.
2. **Closing out a file.** The moved symbol was the last thing left in the old file, which
   the PR deletes.
3. **Part of a dead-code cleanup.** Neighbouring code was deleted and the survivors were
   regrouped.
4. **Layering.** The symbol was in the wrong layer (an HTTP helper in a domain module) and
   moved to where its dependencies point the right way.
5. **Making something reusable.** It moved into a shared module for a second caller. Check
   that the second caller exists. If it doesn't, this is [REL-09](#rel-09-move-into-a-shared-utility-module).

The PR description or linked ticket usually says which one it is. When it doesn't, the
references at the base commit usually show it.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Is the body unchanged? | Side-by-side compare | `color-moved`, `tree-sitter-diff` on the two bodies |
| Where did it come from, and why was it there? | Git blame / Timeline on the old file | `blame-C`, `log-L` on the old function |
| Who called it before, and from where? | Go to References at the base commit | `lsp-references` at base |
| Does anything still point at the old location? | Search across files for the old module path and name | `ripgrep` for the old dotted path, old import path and old name |
| Was it public? | Check `__all__`, package `__init__`, `index.ts` barrels, `package.json` `exports` | `read-file` on those files at base and head |
| What does the PR say it's for? | Read the description and ticket | `linked-work-item` |

### What not to spend review on

The moved body. If it moved unchanged, its logic, naming, error handling and style were
reviewed when it was written. Re-reviewing it as new code is the failure this catalog exists
to prevent. Domain playbooks don't re-run on it either, unless the move changes its context
(see "How it combines").

### Checklist

- **Every reference is updated.** Imports, call sites, re-exports, type-only imports, and
  `TYPE_CHECKING` blocks. Check each one: should it be updated, or should the call go away?
- **String references are updated.** A rename refactor doesn't catch these. Search for the
  old dotted path and old file path in:
  - `mock.patch("pkg.a.parse_invoice")` targets. The patch target is where the name is looked
    up, so after a move it's usually the *importing* module, not `pkg.b`.
  - `vi.mock("./a")` and `jest.mock("./a")` paths
  - dynamic imports: `importlib.import_module`, `import()`
  - config files and entry points (`pyproject.toml` scripts, `package.json` `bin`/`exports`)
  - framework registries: Django `INSTALLED_APPS`, a Celery task name, a FastAPI router include
  - logging config keyed by logger name, which defaults to `__name__`
  - docs and runbooks that cite the old path
- **The public surface is intact, or the break is intended.** If the old location was
  importable by other packages, a move is a breaking change under
  [Hyrum's Law](../../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law). Ask for a
  re-export from the old path for one release, or a stated break.
- **Tests moved with the code.** Tests named after the old module (`test_a.py`, `a.test.ts`)
  either move to match, or still import from the new location correctly. Fixtures and fakes
  for the moved code follow it, per the guide's
  [test-code rules](../../Code-Review-Guide-and-Playbooks.md#test-code-itself-helpers-fixtures-and-fakes).
- **The old file is handled.** If it's now empty or holds only imports, it should be deleted,
  along with its test file and any `__init__` or barrel entry.
- **The rename, if any, reads well at every call site.** A name that made sense in the old
  module may now stutter (`billing.billing_parse`) or lose meaning.
- **No import cycle appeared.** Moving a symbol can make the destination import something
  that imports it back.

### How it combines with domain playbooks

It narrows them. The moved body skips the domain checks that applied when it was written: a
moved input validator doesn't get the full
[input validation](../../Code-Review-Guide-and-Playbooks.md#code-that-validates-user-input)
pass again. The exception is when the move changes the code's context, and then that domain's
playbook applies to the change of context:

- an auth check moved from a router-level dependency into a handler, or the reverse
- code moved across a trust boundary
- code moved into a module that runs at import time
- code moved from sync to async code

### Red flags

- **A "pure move" whose body changed.** Any logic difference turns this into REL-10.
- **Names registered from the module path.**
  - A Celery task's default name includes its module, so messages already queued under the
    old name fail after deploy.
  - Pickled objects and Django content types store dotted paths.
  - Next.js and other file-based routers turn a file move into a URL change.
- **Mocks patched at the old path still pass.** `mock.patch("pkg.a.parse_invoice")` with
  `create=True`, or a module that still exists, can patch nothing and let a test pass
  vacuously.
- **A move with no stated reason into a shared module.** See REL-09.

### Worked example

```diff
--- a/billing/invoices.py
+++ b/billing/invoices.py
-def parse_line_items(raw: list[dict]) -> list[LineItem]:
-    return [LineItem.from_row(r) for r in raw]
--- a/billing/importer.py
+++ b/billing/importer.py
-from billing.invoices import parse_line_items
+def parse_line_items(raw: list[dict]) -> list[LineItem]:
+    return [LineItem.from_row(r) for r in raw]
--- a/tests/billing/test_importer.py
+++ b/tests/billing/test_importer.py
-@patch("billing.invoices.parse_line_items")
+@patch("billing.importer.parse_line_items")
```

A good review says:

1. This is a move.
2. `importer.py` was the only caller at base, so the move improves cohesion.
3. The body is unchanged, so no logic comments.
4. Then it runs the checks. `rg "billing.invoices.parse_line_items|invoices import parse_line_items"`
   finds a second `@patch` in `tests/billing/test_reports.py` still on the old path. That's
   the finding.

### ai-review-bot today

The bot can't see a move. Every agent receives the deletion and the addition as unrelated
hunks, ordered by language and size by `packDiff()`, so they may sit far apart in the prompt.
Under budget pressure the deletion-only hunk is dropped, which leaves only the "new" function.
No agent can search for remaining references, and the GitHub API's rename detection covers
whole files only. What it would need: the moved-block detection from `color-moved` or a
tree-sitter body comparison, and a references and string search at base and head.

### Eval seed

On a PR that moves one function unchanged to its only caller and leaves one stale
`mock.patch` path, the review names the move, makes no comments on the moved body, and flags
the stale patch target.

## REL-02: File moved or renamed

```yaml
id: REL-02
name: File moved or renamed
family: relocation
aliases: [git mv, rename file]
signals:
  - GitHub reports status "renamed" with previous_filename
  - a deleted file and an added file with the same or near-identical content
  - import paths changing across many files with no other edits
narrows_playbooks: true
escalates_with: [public-api, critical-path]
guide_refs:
  - "#compatibility-hyrums-law"
  - "#review-locally-not-only-in-the-browser"
tools: [pr-files-api, git-diff-M, log-follow, ripgrep, lsp-references]
bot_visibility: partial
```

### What it looks like in a diff

GitHub shows `old/path.ts → new/path.ts` with a similarity score. If the file was also edited,
the diff shows only the edits. Elsewhere, many files change a single import line.

### How to recognize it

GitHub and `git diff -M` both detect whole-file renames by content similarity (git's default
threshold is 50%). Below that threshold a renamed and heavily edited file shows up as a delete
plus an add, so compare the two directly. If the content matches but the file was split or
merged, see REL-04 and REL-05.

### Likely intents

- making the name match the content
- moving to the directory where its peers live
- a naming convention change (`fooService.ts` → `foo-service.ts`)
- part of a package restructure (REL-08)

### Context to gather

- `log-follow` on the new path to keep the file's history.
- `ripgrep` for the old path in:
  - imports
  - config (`tsconfig` `paths`, bundler aliases, `pyproject`)
  - CI workflows
  - Dockerfiles (`COPY`)
  - docs
  - `CODEOWNERS`
  - lint ignore lists
- `lsp-references` for its exported symbols.

### What not to spend review on

Unchanged content. Review only the edits GitHub shows inside the renamed file.

### Checklist

- every importer updated, including path aliases and barrel files (`index.ts`, `__init__.py`)
- non-code references to the path updated:
  - build and CI config
  - Dockerfile `COPY`
  - `CODEOWNERS`
  - coverage and lint excludes
  - docs and runbooks
- tests renamed to match, if the repo names tests after source files
- for file-routed frameworks (Next.js `app/`, `pages/`), the URL change is intended, and old
  URLs redirect
- for a published package, the old path still resolves or the break is announced

### How it combines with domain playbooks

It narrows them to the in-file edits. A route file's move widens to the
[endpoint schema change](../../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation)
playbook, because the path is part of the contract.

### Red flags

- Case-only renames (`User.ts` → `user.ts`) break on case-insensitive filesystems and in some
  git setups.
- A rename that also changes a lot of content: the similarity score hides how much changed.
- A `CODEOWNERS` entry left pointing at the old path silently drops required reviewers.

### Worked example

`src/lib/fetchUser.ts → src/users/fetch-user.ts`, with 14 import lines updated. `rg fetchUser`
finds `vitest.config.ts` coverage `exclude` and `docs/architecture.md` still citing the old
path. Those are the comments, and there are none on the file's contents.

### ai-review-bot today

The GitHub files API reports `previous_filename`, and `retargetCarried()` uses renames to
carry earlier findings. The agents' prompt doesn't present the change as a rename, and nothing
searches for leftover references to the old path. What it would need: rename info in the
prompt, and a string search at head.

### Eval seed

On a rename with one stale config path, the review flags the config path and leaves the
unchanged file contents alone.

## REL-03: Symbol renamed in place

```yaml
id: REL-03
name: Symbol renamed in place
family: relocation
aliases: [rename refactor, rename variable, rename function]
signals:
  - one identifier replaced by another across many files, with no other edits on those lines
  - definition and all usages change together
narrows_playbooks: true
escalates_with: [public-api]
guide_refs:
  - "#least-astonishment"
  - "#compatibility-hyrums-law"
tools: [lsp-references, ripgrep, workspace-symbols]
bot_visibility: partial
```

### What it looks like in a diff

The same token swap repeated across many hunks. Each changed line differs only in the name.

### How to recognize it

Tokenize the removed and added lines. If the only difference is one identifier, consistently
replaced, it's a rename. An editor's rename refactor produces exactly this shape.

### Likely intents

A clearer name, a domain term from the spec, a naming convention, or resolving a clash.

### Context to gather

- `lsp-references` on the new name, to confirm it covers every former reference.
- `ripgrep` for the old name in strings, comments, docs, serialized keys and other languages'
  files, which an LSP rename doesn't touch.

### What not to spend review on

The logic on every touched line. Only the name changed.

### Checklist

- the new name is better by the guide's
  [least astonishment](../../Code-Review-Guide-and-Playbooks.md#least-astonishment) rules, and
  matches the spec's vocabulary
- no stragglers in strings, comments, docs, log event names, metric names or feature-flag keys
- exported names: old name kept as a deprecated alias, or the break is stated
- serialized names didn't change by accident:
  - a renamed Pydantic field or TypeScript property that is also a JSON key
  - a DB column mapped by attribute name
  - an event payload field

  Any of these is an interface change ([interface.md](interface.md))

### How it combines with domain playbooks

It narrows them to nothing for the code, unless the renamed thing is serialized or public, in
which case the
[schema change](../../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation)
or [migrations](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)
playbook applies.

### Red flags

- A rename of a model attribute that changes its column or JSON key.
- A renamed log event: dashboards and alerts depend on stable names (guide,
  [logging](../../Code-Review-Guide-and-Playbooks.md#logging-and-error-logging)).
- A partial rename that leaves two names for one concept.

### Worked example

`userId` → `accountId` across 30 files. One hunk renames a property of an API response type,
so the JSON key changes from `userId` to `accountId`. That's the one comment: it's a breaking
change for clients.

### ai-review-bot today

Agents see each hunk and may comment on lines that only changed a name. Nothing checks for
stragglers or flags a serialized name change as a contract change. What it would need: a
rename detector over hunks, and a string search at head.

### Eval seed

On a 30-file rename that also renames one response field, the review flags only the response
field.

## REL-04: Module split

```yaml
id: REL-04
name: Module split
family: relocation
aliases: [break up module, extract module]
signals:
  - one large file loses many definitions; several new files gain them
  - the original file keeps re-exports or is deleted
narrows_playbooks: true
escalates_with: [public-api]
guide_refs:
  - "#single-responsibility-and-cohesion"
  - "#coupling-law-of-demeter-and-tell-dont-ask"
tools: [color-moved, lsp-references, ripgrep, module-graph]
bot_visibility: none
```

### What it looks like in a diff

A large deletion from one file and several new files whose contents match pieces of it.

### How to recognize it

Run REL-01's move detection for each new file against the old one. Most of the added lines
match removed lines.

### Likely intents

The old module was a dumping ground (`utils.py`, `helpers.ts`) or a god module, as the guide's
[cohesion section](../../Code-Review-Guide-and-Playbooks.md#single-responsibility-and-cohesion)
describes.

### Context to gather

- `module-graph` before and after, to see whether the new modules have a clear dependency
  direction or form a cycle.
- `lsp-references` per moved symbol.

### What not to spend review on

The moved bodies.

### Checklist

- Each new module has one reason to change and a name that says what it is.
- Things that change together stayed together. A split that separates a function from the
  only helper it uses is scattering.
- No cycles between the new modules.
- If the old module is public, it re-exports for a release, or the break is stated.
- Everything in REL-01's checklist, applied per moved symbol.

### How it combines with domain playbooks

It narrows them. The design section of the guide is what applies.

### Red flags

- New modules named `common`, `shared`, `misc`: the split recreated the dumping ground.
- A split along technical lines (types, constants, functions) rather than features, which the
  guide calls scattering.

### Worked example

`utils.ts` (900 lines) splits into `dates.ts`, `money.ts`, `strings.ts`. That's fine. A split
into `types.ts`, `constants.ts` and `helpers.ts` gets a comment: each feature's pieces now
live in three files.

### ai-review-bot today

The bot sees a large deletion and several "new" files, and reviews all of the new code. What
it would need: per-symbol move detection and a module graph.

### Eval seed

On a split along feature lines with unchanged bodies, the review makes no comments on the
moved code and checks the old module's importers.

## REL-05: Modules merged

```yaml
id: REL-05
name: Modules merged
family: relocation
aliases: [consolidate modules, fold module]
signals:
  - one or more files deleted; their definitions appear in an existing file
narrows_playbooks: true
escalates_with: [public-api]
guide_refs:
  - "#single-responsibility-and-cohesion"
  - "#scattering-cohesive-code-for-reuse"
tools: [color-moved, lsp-references, ripgrep]
bot_visibility: none
```

### What it looks like in a diff

Small files deleted, and an existing file growing by the same content.

### How to recognize it

REL-01 detection, with the sources deleted entirely.

### Likely intents

Undoing scattering: pulling a feature's pieces back into one module.

### Context to gather

- `lsp-references`, to confirm the merged pieces are used together.
- `ripgrep` for the deleted module paths.

### What not to spend review on

The moved bodies.

### Checklist

- the merged module still has one reason to change (it isn't a new god module)
- the deleted modules' importers, mocks and config strings all updated
- the deleted modules' test files merged or moved

### How it combines with domain playbooks

It narrows them.

### Red flags

- A merged file that now mixes layers (domain logic with HTTP or SQL).
- Name clashes resolved by a silent rename (see REL-03).

### Worked example

`orders/constants.py`, `orders/types.py` and `orders/helpers.py` fold into `orders/service.py`,
next to their only user. The guide endorses this. The review checks the three old paths with
`rg`.

### ai-review-bot today

Same as REL-04.

### Eval seed

On a merge that undoes scattering, the review recognizes it as an improvement and checks for
stale paths only.

## REL-06: Extract function or class

```yaml
id: REL-06
name: Extract function or class
family: relocation
aliases: [extract method, extract helper, extract class]
signals:
  - lines removed from a function body and an equivalent new function called in their place
  - a new class whose fields were previously loose parameters
narrows_playbooks: neutral
escalates_with: []
guide_refs:
  - "#premature-decomposition"
  - "#separation-of-concerns-and-the-domain-model"
  - "#constructors-that-take-too-many-arguments"
tools: [color-moved, lsp-references, tree-sitter-diff]
bot_visibility: partial
```

### What it looks like in a diff

A block disappears from a function and reappears as a new function or method, called from the
old spot. For a class extraction, a cluster of parameters becomes a dataclass or interface.

### How to recognize it

The extracted body matches the removed block, with variables turned into parameters.

### Likely intents

Naming a step, reusing it in a second place, or introducing the missing model the guide
describes.

### Context to gather

- `lsp-references` on the new function: how many callers?
- `tree-sitter-diff`: did the extracted body change?

### What not to spend review on

The extracted logic, if unchanged.

### Checklist

Judge it against [premature decomposition](../../Code-Review-Guide-and-Playbooks.md#premature-decomposition):

- does the name clarify the caller?
- is it used twice?
- does it have logic worth testing alone?

If none of these, the extraction made the code harder to follow. A class extraction is
judged by the guide's
[missing-model signs](../../Code-Review-Guide-and-Playbooks.md#separation-of-concerns-and-the-domain-model).
Check also that the extracted function doesn't depend on state it used to read from the
enclosing scope.

### How it combines with domain playbooks

Neutral. The domain didn't change.

### Red flags

- Eight four-line helpers, each called once.
- A captured variable that's now a stale parameter.
- An extracted helper that takes a boolean flag to serve two callers, which the guide calls
  [mode flags](../../Code-Review-Guide-and-Playbooks.md#shared-helpers-that-grow-mode-flags).

### Worked example

A 30-line handler becomes eight private helpers, each called once with names restating their
line. The guide's premature-decomposition comment applies, and there are no comments on the
logic.

### ai-review-bot today

Agents see a new function and review it as new. They have no way to know the body is
unchanged or how many callers it has.

### Eval seed

On an extraction into single-use helpers, the review raises premature decomposition and makes
no logic comments on unchanged code.

## REL-07: Inline function or helper

```yaml
id: REL-07
name: Inline function or helper
family: relocation
aliases: [inline method, remove indirection]
signals:
  - a function deleted and its body pasted at its call sites
narrows_playbooks: neutral
escalates_with: []
guide_refs:
  - "#shared-helpers-that-grow-mode-flags"
  - "#building-for-needs-you-dont-have"
tools: [lsp-references, color-moved, ripgrep]
bot_visibility: partial
```

### What it looks like in a diff

A helper's definition removed; each call site replaced with the helper's body, possibly
specialized.

### How to recognize it

The added blocks at call sites match the removed body, with arguments substituted.

### Likely intents

Removing a wrong abstraction (a helper with mode flags), or a layer that only forwarded calls.

### Context to gather

- `lsp-references` at base: was every caller inlined?
- `ripgrep` for the helper's name in mocks and docs.

### What not to spend review on

The inlined logic, if it matches the old body.

### Checklist

- every former caller now works without the helper, and the specializations match what each
  caller passed
- no remaining mocks of the removed helper
- if the same block now appears three or more times unchanged, the Rule of Three suggests the
  helper was earning its place

### How it combines with domain playbooks

Neutral.

### Red flags

- A specialized inline that dropped a branch the caller relied on.
- Duplicated knowledge (a business rule) rather than duplicated text.

### Worked example

`render(obj, compact=False, legacy=False)` is inlined into its three callers, each keeping
only its branch. The guide endorses this, so the review checks each caller kept the right
branch.

### ai-review-bot today

Agents see repeated new code and may suggest extracting it back into a helper.

### Eval seed

On an inline that removes a mode-flag helper, the review doesn't ask to re-extract it.

## REL-08: Package or directory restructure

```yaml
id: REL-08
name: Package or directory restructure
family: relocation
aliases: [reorganize, feature folders, layer folders]
signals:
  - many renamed files across directories
  - import paths rewritten across most of the codebase
narrows_playbooks: true
escalates_with: [public-api]
guide_refs:
  - "#single-responsibility-and-cohesion"
  - "#size-the-change-before-reading-it"
tools: [pr-files-api, ripgrep, module-graph]
bot_visibility: partial
```

### What it looks like in a diff

Dozens of renames, often with small edits, and a large import churn.

### How to recognize it

Mostly REL-02 renames sharing a common directory change.

### Likely intents

Moving from layer folders (`models/`, `services/`, `routes/`) to feature folders, or the
reverse; aligning with a framework convention.

### Context to gather

- `module-graph` before and after.
- `ripgrep` for every old directory prefix in config, CI, Docker and docs.

### What not to spend review on

Content of files that only moved.

### Checklist

- the new structure follows the guide's cohesion rules (things that change together live
  together)
- every old directory prefix is gone from config and tooling
- the PR contains no behavior changes. The guide says mechanical edits go in their own
  commits, so ask to split any behavior change out.

### How it combines with domain playbooks

It narrows them to nothing for moved files, and full review for anything else.

### Red flags

- Behavior changes hidden inside a 200-file restructure: see the composite family in
  [composite.md](composite.md).
- A restructure with no tests run in CI for the new paths.

### Worked example

A 180-file restructure that also changes one default value. The default change is the comment,
with a request to split it out.

### ai-review-bot today

Large restructures exceed the diff budget. `packDiff()` truncates and names omitted files, so
reviewers see a fragment. What it would need: rename-aware packing that collapses pure renames
into one line each.

### Eval seed

On a restructure with one hidden behavior change, the review finds that change and nothing in
the renamed files.

## REL-09: Move into a shared utility module

```yaml
id: REL-09
name: Move into a shared utility module
family: relocation
aliases: [promote to utils, make reusable]
signals:
  - code moving from a feature module into utils/, common/, shared/, lib/ or a constants file
  - only one caller of the moved code at head
narrows_playbooks: true
escalates_with: []
guide_refs:
  - "#scattering-cohesive-code-for-reuse"
  - "#constants-for-self-explanatory-literals"
  - "#route-constants-instead-of-readable-paths"
tools: [lsp-references, color-moved]
bot_visibility: none
```

### What it looks like in a diff

REL-01, with a shared module as the destination.

### How to recognize it

The destination path is a shared or utility location, and `lsp-references` at head finds one
caller, or one plus tests.

### Likely intents

Reuse that doesn't exist yet, or because a test needs to import it. The guide says neither is
a reason.

### Context to gather

`lsp-references` at head: count callers outside the original feature.

### What not to spend review on

The moved body.

### Checklist

- a second, unrelated caller exists. If not, the code goes back next to its user.
- tests import from the production module, rather than the code moving to `utils` for them
- constants moved into a constants file are knowledge, not
  [self-explanatory literals](../../Code-Review-Guide-and-Playbooks.md#constants-for-self-explanatory-literals)

### How it combines with domain playbooks

It narrows them.

### Red flags

- Route paths moved into a `uris` constants file:
  [route constants](../../Code-Review-Guide-and-Playbooks.md#route-constants-instead-of-readable-paths).

### Worked example

`format_invoice_number` moves from `billing/invoices.py` to `common/formatting.py`, with one
caller. The comment cites scattering and asks to move it back.

### ai-review-bot today

The bot can't count callers, and it can't tell a move from new code.

### Eval seed

On a move into `utils/` with one caller, the review flags scattering.

## REL-10: Move plus modify

```yaml
id: REL-10
name: Move plus modify
family: relocation
aliases: [move and change, refactor with behavior change]
signals:
  - a move per REL-01 where the bodies differ by a few logic lines
narrows_playbooks: false
escalates_with: [public-api, trust-boundary, auth, data-write, money]
guide_refs:
  - "#size-the-change-before-reading-it"
  - "#hand-the-mechanical-rules-to-tools"
tools: [tree-sitter-diff, color-moved, blame-C]
bot_visibility: none
```

### What it looks like in a diff

A move, except a condition, constant or call inside the body differs between the old and new
versions.

### How to recognize it

Diff the old body against the new body directly, ignoring whitespace and the symbol's name.
Any remaining difference is a behavior change hiding in a move. This comparison is the one
that matters; reading the added side on its own doesn't show it.

### Likely intents

Usually a fix or tweak made "while I was in there". Sometimes the change was needed to make
the move compile (an import or parameter), which is mechanical.

### Context to gather

- `tree-sitter-diff` between the old and new body.
- `blame-C` to separate moved lines from changed ones.

### What not to spend review on

The lines that moved unchanged.

### Checklist

- every changed line inside the moved body gets a full review, as new behavior, with the
  matching domain playbook
- the PR states the change. The guide's
  [size the change](../../Code-Review-Guide-and-Playbooks.md#size-the-change-before-reading-it)
  rule says renames and moves go in their own commits so the behavior change stays legible.
  Ask for that split.
- tests cover the changed behavior, not just the move

### How it combines with domain playbooks

It widens them for the changed lines, which get the full domain review, and narrows them for
the rest.

### Red flags

- A security check, limit or guard altered inside a moved block.
- A PR description that says "no functional change".

### Worked example

`charge()` moves from `payments/service.py` to `billing/charge.py`, and in transit
`if amount <= 0` becomes `if amount < 0`. The review names the move, makes no comments on the
moved lines, and flags the boundary change as a behavior change that zero-amount charges now
reach the gateway.

### ai-review-bot today

Invisible. The bot sees the new body as new code, so it may still comment on the changed
condition, but by luck and buried among comments on unchanged lines.

### Eval seed

On a move with one changed comparison, the review flags exactly that comparison and nothing
else in the moved body.
