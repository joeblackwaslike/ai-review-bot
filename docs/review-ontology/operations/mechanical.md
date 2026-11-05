# Mechanical operations

Changes a tool made, or that a tool could have made, where the intent is that nothing the
program does is different afterwards. Formatting, import order, generated output, lockfiles and
type annotations all belong here. They are the biggest diffs in a typical repository and the
cheapest to review, provided the reviewer can show that they are only mechanical.

The review effort goes into that proviso. Mechanical entries narrow review, but only after two questions
get a yes. Is it really only mechanical? Was it kept apart from behavior changes? The guide
says the second one directly: renames, moves and formatting go in their own commits "so the
behavior change stays legible"
([size the change](../../Code-Review-Guide-and-Playbooks.md#size-the-change-before-reading-it)).
When either answer is no, the PR is a composite ([composite.md](composite.md)), and the
mechanical part hides the behavioral part.

A good test for any entry in this file is to ask what a tool would produce. If the author can
name the command (`ruff format`, `prettier --write`, `pnpm install`, a codemod) and a reviewer
can run it and get the same diff, the diff is verified without reading it. The relocation
family ([relocation.md](relocation.md)) is the neighbouring case, where the change is
structural, and [interface.md](interface.md) covers mechanical-looking changes that touch a
contract.

## MEC-01: Formatter-only change

```yaml
id: MEC-01
name: Formatter-only change
family: mechanical
aliases: [reformat, whitespace change, prettier run, ruff format, black run, biome format]
signals:
  - hunks where the removed and added lines differ only in whitespace, line breaks, trailing commas or quote style
  - a long line wrapped into several, or several joined into one
  - the PR title or commit says "format", "prettier", "ruff format", "black" or "lint"
  - the same file touched across the repo with indentation or brace-position changes
narrows_playbooks: true
escalates_with: []
guide_refs:
  - "#hand-the-mechanical-rules-to-tools"
  - "#size-the-change-before-reading-it"
tools: [color-moved, tree-sitter-diff, read-file, ci-results, agent-instructions]
bot_visibility: partial
```

### What it looks like in a diff

Many files, many changed lines, and no new names. Python lines gain trailing commas and are
re-wrapped. TypeScript lines change quotes, semicolons or parenthesization of arrow-function
arguments. Blank lines appear or vanish.

### How to recognize it

`git diff -w` is a first look, not proof. It hides indentation and spacing changes, but it
also hides whitespace changes inside string literals (`"a b"` to `"ab"`) and Python
indentation changes that move a statement in or out of a block, and both change behavior. The
proof is one of two things. Either rerun the formatter at base with head's config and get
head's output byte for byte, or compare syntax trees with `tree-sitter-diff`, which keeps
string contents and block structure. If the trees match, the change cannot affect behavior. Look at the formatter's config at head,
because the diff is explained by it.

Look-alikes to rule out:

- **A formatter run with new settings.** The config changed in the same PR, which is
  [MEC-10](#mec-10-tooling-config-loosened).
- **Reformatting plus an edit.** One line differs in content. That is a behavior change hidden
  in churn ([CMP-02](composite.md#cmp-02-cleanup-pr-that-is-really-several-prs)).
- **String content.** Whitespace inside a string literal, a docstring or a template changes
  behavior, and a formatter doesn't touch it.

### Likely intents

1. Apply the project's formatter to files that drifted.
2. A formatter version bump changing its output.
3. Switching formatters (black to ruff, prettier to biome).
4. A pre-commit hook the author ran for the first time.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Does the diff vanish when whitespace is ignored? | Re-run the diff with whitespace ignored | `color-moved`, `read-file` at base and head |
| Do the syntax trees match? | Compare structurally | `tree-sitter-diff` |
| Which tool and version produced it? | Config and lockfile at head | `read-file`, `agent-instructions` |
| Does CI already check formatting? | Look for a format check in the workflow | `ci-results` |

### What not to spend review on

Every line the formatter changed. Style choices are the tool's, per the guide's rule that a
mechanical rule belongs in configuration
([hand the mechanical rules to tools](../../Code-Review-Guide-and-Playbooks.md#hand-the-mechanical-rules-to-tools)).

### Checklist

- The change reproduces from the repo's own formatter at the pinned version. If CI runs a
  format check and passes, that is the evidence.
- No non-whitespace difference exists. A structural diff, or a diff with whitespace ignored,
  shows nothing beyond the tool's own output.
- The commit holds only formatting. If feature work is in the same commit, ask to split it, so
  that the formatting commit can be skipped in blame and bisect.
- The change is in files the PR's purpose touches. A repo-wide reformat inside a feature PR is
  a scope problem.
- Large reformat commits are listed in `.git-blame-ignore-revs`, if the repo uses one, so blame
  stays useful. This is a suggestion, not a requirement.
- No formatter disable comments (`# fmt: off`, `// prettier-ignore`) were added to dodge the
  tool.

### How it combines with domain playbooks

It narrows them to nothing for the formatted lines. Domain playbooks apply only to the lines
that are not formatting.

### Red flags

- A formatting commit that also changes a string, a regex or a literal.
- A formatter or its config upgraded in the same PR.
- A reformat of files in a security-sensitive path with other changes hidden among them.
- Generated files reformatted by hand.

### Worked example

A PR titled "chore: format" touches 140 Python files. `git diff -w` shrinks the diff by 95%.
The rest is trailing commas and parenthesized return values, which `ruff format` produces
unchanged on a clean checkout. One hunk in `billing/rates.py` changes `0.0725` to `0.075`. That
line is the review.

### ai-review-bot today

The bot reads every changed line as if it were new. It has no whitespace-insensitive view of
the diff, and it can't tell that a hunk is formatting only, so it can comment on style choices
the formatter owns. `classifyTier()` counts additions and deletions, so a large reformat can
push a PR to the complex tier. What it would need: a whitespace-insensitive pass, to drop
format-only hunks from the prompt and name them in a count.

### Eval seed

On a 100-file formatter run with one number changed inside it, the review ignores the
formatting and flags the number.

## MEC-02: First-time format of legacy code

```yaml
id: MEC-02
name: First-time format of legacy code
family: mechanical
aliases: [adopt formatter, introduce prettier, introduce black, baseline reformat]
signals:
  - formatter config (`pyproject.toml` [tool.ruff.format], `.prettierrc`, `biome.json`) added in the same PR as reformatted files
  - a pre-commit config or a CI format job added
  - most of the repo's files appear in the diff with whitespace-style changes
  - a `.git-blame-ignore-revs` file added or edited
narrows_playbooks: true
escalates_with: []
guide_refs:
  - "#hand-the-mechanical-rules-to-tools"
  - "#size-the-change-before-reading-it"
  - "#configuration-files"
tools: [read-file, tree-sitter-diff, ci-results, pr-files-api, agent-instructions]
bot_visibility: partial
```

### What it looks like in a diff

The same as MEC-01, at the scale of the whole repository, along with new tool configuration.

### How to recognize it

The config and the reformat arrive together, or the config arrived in the previous commit and
this one applies it. The file list is long and the per-file change is small.

### Likely intents

Adopt the guide's rule that mechanical standards belong to tools, and stop reviewers from
commenting on style.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What does the new config set? | Read it, compare to the language's defaults | `read-file` |
| Does a clean checkout plus the tool reproduce the diff? | Run the formatter on the base commit | not available to an agent; use `ci-results` for a format check job |
| Which files are excluded? | Look at ignore lists | `read-file` |
| Is anything other than formatting in the file list? | List files and statuses | `pr-files-api` |

### What not to spend review on

The reformatted code. Review the config and the commit structure.

### Checklist

- Formatter config and the reformat are separate commits, with the config first, so the
  reformat commit is exactly "run the tool".
- The config is reasonable and not tuned to hide something. Excludes are listed and justified
  ([tooling config](../../Code-Review-Guide-and-Playbooks.md#configuration-files)).
- CI enforces the formatter from here on, or the reformat will drift back.
- Pre-commit and editor settings match CI's version.
- The reformat commit is added to the blame ignore file, so `git blame` still points at the
  real author. GitHub's blame view honors `.git-blame-ignore-revs`.
- Open PRs will conflict. The author says how contributors should rebase.
- No behavior change rides along.

### How it combines with domain playbooks

It narrows them to nothing for reformatted code. The config file gets the configuration
playbook.

### Red flags

- Config and a hand-edited subset of files in a single commit.
- Excludes covering the files that matter most.
- No CI check, so the baseline decays.

### Worked example

A PR adds `ruff format` config and reformats 400 files in two commits. The review reads the
config commit (10 lines) and checks the second against a run of CI's format job. It asks for
`.git-blame-ignore-revs` and notes that the config excludes `migrations/`, which is fine for
generated migrations but also covers hand-written data migrations.

### ai-review-bot today

A baseline reformat is bigger than the diff budget, so `packDiff()` cuts most of it and names
the omitted files. The review then covers a fraction of the files, and the config file may be
sorted behind larger patches. No agent can run the formatter.

### Eval seed

On a baseline reformat with the config in a separate first commit, the review comments on the
config and CI enforcement, not on formatted lines.

## MEC-03: Lint autofix

```yaml
id: MEC-03
name: Lint autofix
family: mechanical
aliases: [ruff --fix, eslint --fix, biome check --write, clippy fix, unsafe-fixes]
signals:
  - many small identical edits across files that match one lint rule (`!= None` to `is not None`, `var` to `const`, `==` to `===`, `% formatting` to f-strings)
  - removal of unused imports and variables, or dead assignments
  - '`typing.List` to `list`, `Optional[X]` to `X | None`, `os.path` to `pathlib`'
  - the commit mentions `--fix`, `--unsafe-fixes` or a rule code (`UP`, `SIM`, `C4`, `PTH`, `F401`, `prefer-const`)
narrows_playbooks: true
escalates_with: [public-api]
guide_refs:
  - "#hand-the-mechanical-rules-to-tools"
  - "#idiomatic-python"
  - "#size-the-change-before-reading-it"
tools: [tree-sitter-diff, ripgrep, read-file, ci-results, agent-instructions]
bot_visibility: partial
```

### What it looks like in a diff

The same rewrite many times. Each hunk is small and the pattern is regular.

### How to recognize it

Group hunks by shape. If each group is one rule's rewrite, the diff is an autofix. Rules differ
in how safe they are: some preserve behavior by definition, and some are labelled unsafe by
the tool because they can change it.

### Likely intents

Enable a rule and fix the backlog, or clear a warning count before turning a warning into an
error.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Which rules produced this? | Read the commit message and config | `read-file`, `agent-instructions` |
| Is each rule behavior-preserving? | Check the tool's docs for "unsafe" fixes | tool documentation, verify rather than assume |
| Is any rewritten name public? | Check `__all__`, exports | `ripgrep`, `read-file` |
| Did the test suite pass? | CI | `ci-results` |

### What not to spend review on

The rewrites that match a safe rule. Groups of identical hunks are reviewed once, not once per
file.

### Checklist

- Every hunk fits a rule named by the author. Odd hunks are inspected.
- Rules the tool marks unsafe get a careful look. Examples include fixes that change a
  comparison to `is` or remove an import with side effects.
- Removed "unused" imports are really unused. An import kept for its side effects (plugin
  registration, model discovery, `__init__` re-export) breaks silently when removed.
- Removed "unused" variables did not have a side-effecting right-hand side.
- Type syntax modernization (`Optional[X]` to `X | None`) matches the minimum supported Python.
  `X | None` needs 3.10 at runtime in annotations that are evaluated.
- A re-export removed because it looked unused is still imported from outside the package.
- Rule changes in config, if any, are separate from the fix commit.

### How it combines with domain playbooks

It narrows them to nothing for rule-conforming rewrites, and the idiom rules in the guide are
the standard. Anything outside the rule gets a normal review.

### Red flags

- `--unsafe-fixes` applied repo-wide.
- Removed imports in `__init__.py` or plugin modules.
- A mix of rule rewrites and hand edits in the same files.
- Fixes in test files that change what the test exercises.

### Worked example

`ruff --fix` for `F401` removes `from .handlers import *` style imports from
`plugins/__init__.py`. The imports registered handlers on import. The review spots the file in
the list, searches for the registry, and finds nothing registers `webhook_handler` anymore.
The other 60 hunks are skipped.

### ai-review-bot today

The agents review each rewrite on its own. They can't confirm that an import is unused repo-wide
or that a re-export has outside users, because they only see the patch. Many findings on this
kind of PR are style opinions on lines the tool chose.

### Eval seed

On an autofix run that also drops a side-effect import, the review flags that import and
ignores the other rewrites.

## MEC-04: Import sort or reorder

```yaml
id: MEC-04
name: Import sort or reorder
family: mechanical
aliases: [isort, organize imports, import grouping, sort-imports]
signals:
  - the same set of import lines in a different order in a file's header
  - imports regrouped into stdlib, third-party and first-party blocks
  - removed and added import lines that are identical after sorting
narrows_playbooks: true
escalates_with: [critical-path]
guide_refs:
  - "#hand-the-mechanical-rules-to-tools"
  - "#size-the-change-before-reading-it"
tools: [tree-sitter-diff, read-file, ripgrep, ci-results]
bot_visibility: partial
```

### What it looks like in a diff

A block of imports at the top of each file with lines moving up and down. The count of import
lines is unchanged.

### How to recognize it

Sort both sides of the import block. If the sorted lists are identical, it is a reorder. If one
list has an extra or missing line, it is not purely a reorder.

### Likely intents

Applying `ruff` rule `I` (isort-compatible), `isort`, or a TypeScript import-sorting plugin.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Are the sorted import sets identical? | Compare both sides | `tree-sitter-diff`, `read-file` |
| Does any module depend on import order? | Look for side-effect imports and circular imports | `ripgrep`, `read-file` |
| Does CI sort-check? | Look at the workflow | `ci-results` |

### What not to spend review on

The ordering itself.

### Checklist

- The set of imports is unchanged. A difference means an import was added or removed.
- No file relies on import order for behavior. In Python this covers modules that register
  something on import, patch a global, or break an import cycle by importing late. In
  TypeScript it covers CSS imports, polyfills, `reflect-metadata` and `import "./setup"`
  lines, whose order matters.
- Imports guarded for a purpose (`if TYPE_CHECKING:`, a function-local import that avoids a
  cycle) stayed where they were.
- Sorting rules match the config in the repo and are enforced by CI.

### How it combines with domain playbooks

It narrows them to nothing. Side-effect imports are the one place it can matter.

### Red flags

- A function-local import hoisted to the top, producing a cycle at startup.
- `import "./polyfill"` moved below code that needs it.
- An import added "while sorting".

### Worked example

An import sort touches 80 files. In `app/main.py`, `from app import telemetry` (which patches
the HTTP client on import) moves below `from app.routes import api`. The review notes that
routes now create their clients before the patch applies.

### ai-review-bot today

The agents see reordered import lines as removed and added code and sometimes comment on
unused or duplicated imports that were already there. They can't see that an import has side
effects.

### Eval seed

On a repo-wide import sort that moves one patching import below its users, the review flags that
one file.

## MEC-05: Type-annotation-only change

```yaml
id: MEC-05
name: Type-annotation-only change
family: mechanical
aliases: [add type hints, add types, annotate, strict mode migration, any to unknown]
signals:
  - 'added `: Type` / `-> Type` annotations or `TypedDict`, `Protocol`, `Literal` definitions with no body changes'
  - TypeScript `interface` / `type` additions, `as` casts, `!` non-null assertions, `any` replaced by a concrete type
  - '`# type: ignore`, `# pyright: ignore`, `@ts-ignore`, `@ts-expect-error` or `cast(...)` added'
  - stub files (`.pyi`, `.d.ts`) added or changed
narrows_playbooks: true
escalates_with: [public-api]
guide_refs:
  - "#explicit-over-implicit"
  - "#data-models-that-cant-hold-illegal-states"
  - "#hand-the-mechanical-rules-to-tools"
  - "#configuration-files"
tools: [tree-sitter-diff, lsp-references, ripgrep, read-file, ci-results]
bot_visibility: partial
```

### What it looks like in a diff

Signatures gain annotations, and bodies are untouched. In TypeScript, types appear on exports
and function parameters. Occasionally a cast or ignore comment appears next to a call.

### How to recognize it

Strip annotations from both sides and compare. If the code is identical, the change is
annotation-only at runtime. Not everything called a type is inert: some annotations are
evaluated at runtime (Pydantic models, dataclasses, FastAPI parameters, `typing.get_type_hints`
users, ORM column types), and changing them changes behavior.

### Likely intents

Raising type coverage, enabling `mypy --strict` or `strict` in `tsconfig`, or documenting a
contract.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Are any annotations read at runtime? | Search for Pydantic, FastAPI, dataclass, `get_type_hints`, Zod-from-type use | `ripgrep`, `read-file` |
| Do the types match what callers pass? | References on the annotated symbol | `lsp-references` |
| Did the checker pass without new ignores? | CI results for `mypy` or `tsc --noEmit` | `ci-results` |
| Did the config loosen? | Diff `pyproject.toml` / `tsconfig.json` | `read-file` |

### What not to spend review on

Annotations that restate the obvious from the body, apart from their accuracy.

### Checklist

- **Runtime-evaluated annotations are treated as behavior.** A FastAPI parameter typed `int`
  becomes 422 for non-integers. A Pydantic field that gained `| None` accepts null. A
  validated type that loosened to `Any` removes validation. That is an interface change
  ([interface.md](interface.md)).
- Types tell the truth. A `str` annotation on something that can be `None`, or a TypeScript `as`
  cast that overrides the checker, makes the type wrong. The guide's
  [explicit over implicit](../../Code-Review-Guide-and-Playbooks.md#explicit-over-implicit)
  is the standard.
- Every new `type: ignore`, `@ts-ignore`, `cast` and non-null `!` has a reason, and prefers
  `@ts-expect-error` to `@ts-ignore` so it fails when the problem goes away.
- Public types are exported on purpose, since an exported type is a contract.
- Strictness did not drop to make the PR pass
  ([tooling config](../../Code-Review-Guide-and-Playbooks.md#configuration-files)). See
  [MEC-10](#mec-10-tooling-config-loosened).
- Types prevent illegal states where cheap, rather than only describing the loose version
  ([data models](../../Code-Review-Guide-and-Playbooks.md#data-models-that-cant-hold-illegal-states)).

### How it combines with domain playbooks

It narrows them to nothing for inert annotations. It widens to the endpoint-schema playbook
when annotations are request or response models.

### Red flags

- `Any` or `unknown as X` used to silence an error.
- A wave of `# type: ignore` with no error codes.
- `strict` turned off in a sub-package.
- A "types only" PR that edits a function body.

### Worked example

"Add type hints to the API layer" annotates 40 handlers. One handler's `limit: int = 10`
becomes `limit: int | None = None`, which in FastAPI changes the default and accepts an
explicit null. The review asks whether the unbounded default is intended, because
`limit=None` now returns every row.

### ai-review-bot today

Agents see annotation changes as code and may comment on them as if they changed behavior, or
miss the one that does. Whether an annotation is evaluated at runtime needs framework
knowledge the prompt doesn't supply. `type-design-analyzer` runs for typed files with type
definitions.

### Eval seed

On a type-hints PR that changes a FastAPI parameter's default to `None`, the review flags the
behavior change and leaves the other annotations alone.

## MEC-06: Codemod or bulk find-and-replace

```yaml
id: MEC-06
name: Codemod or bulk find-and-replace
family: mechanical
aliases: [codemod, jscodeshift, libcst, sed across repo, search and replace, API migration sweep]
signals:
  - one rewrite pattern repeated across dozens of files, in code and tests
  - a deprecated API call replaced by its successor everywhere
  - a script or codemod added in the PR, or named in the description (`jscodeshift`, `libcst`, `ast-grep`, `comby`, `sed`, `ruff --fix` with a custom rule)
  - string replacement hitting comments, docs and test names alongside code
narrows_playbooks: true
escalates_with: [public-api, trust-boundary, auth, data-write, money]
guide_refs:
  - "#size-the-change-before-reading-it"
  - "#hand-the-mechanical-rules-to-tools"
  - "#compatibility-hyrums-law"
tools: [tree-sitter-diff, ripgrep, lsp-references, read-file, ci-results, pr-files-api]
bot_visibility: partial
```

### What it looks like in a diff

Hundreds of hunks that share a shape. Hand edits are fewer, scattered, and easy to miss among
them.

### How to recognize it

Group hunks by their removed and added text. The large groups are the codemod. The small
groups, and any hunk outside the groups, are hand edits or places where the pattern did not
fit cleanly.

### Likely intents

An API or library migration (old client to new client), a rename of a widely used symbol, or a
deprecation sweep.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What is the rule? | Read the script or the PR description | `read-file`, `linked-work-item` |
| What did the rule not cover? | Search for the old pattern at head | `ripgrep` |
| Which hunks don't fit the rule? | Group and diff hunks | `tree-sitter-diff`, `pr-files-api` |
| Do old and new calls behave the same? | Read both APIs' docs for defaults, errors, types | `read-file`, library docs |

### What not to spend review on

Hunks that match the rule exactly. Review the rule once, then the outliers.

### Checklist

- **The rule is correct for the general case.** Read the script or the pattern, then check it
  against the old and new APIs' differences: argument order, defaults, return types, error
  behavior, async vs sync.
- **Nothing was left behind.** `rg` for the old pattern finds only intended survivors.
- **Nothing was over-matched.** Text replacement hits unrelated identifiers, strings, log event
  names, SQL, JSON keys and comments. Check string literals touched by the replacement.
- **The outliers are reviewed.** Every hunk that does not match the rule is a hand edit and gets
  a full review. They tend to be the interesting ones.
- **The tool and its inputs are reproducible.** The script is committed or described, so a
  reviewer can rerun it.
- **It is separated from behavior.** The swap is its own commit, and the diff is not mixed
  with logic changes ([CMP-02](composite.md#cmp-02-cleanup-pr-that-is-really-several-prs)).
- Tests changed by the codemod still test what they tested.

### How it combines with domain playbooks

It narrows them for rule-conforming hunks. It widens them when the replacement API differs in
behavior in a sensitive domain: the new auth client, the new money type, the new serializer.

### Red flags

- A new API with different defaults (timeouts, retries, encoding, null handling).
- Hand-edited hunks inside the sweep.
- `sed` run on JSON, YAML or SQL.
- A rename that touches a serialized key (see
  [REL-03](relocation.md#rel-03-symbol-renamed-in-place)).

### Worked example

A codemod swaps `requests.get(url)` for `httpx.get(url)` in 90 places. The review reads the
rule once and notes the difference in redirect handling: `requests` follows redirects by
default, `httpx` does not. Twelve call sites hit endpoints that redirect. It also finds three
hunks outside the pattern, where hand edits changed the timeout.

### ai-review-bot today

Every hunk is read as new code, so a 90-hunk sweep takes up diff budget and generates
repeated comments on one pattern. The ledger and claim-dedupe code suppress some repeats, but
nothing understands that the hunks come from one rule. The agents can't search for the old
pattern still present at head.

### Eval seed

On a 90-hunk client swap that changes redirect behavior, the review makes one comment on the
rule and no per-hunk comments.

## MEC-07: Generated code regeneration

```yaml
id: MEC-07
name: Generated code regeneration
family: mechanical
aliases: [regen, codegen, protobuf regen, OpenAPI client regen, ORM migration autogenerate, snapshot update]
signals:
  - a header such as "DO NOT EDIT", "Code generated by", "@generated", "auto-generated"
  - files named `*_pb2.py`, `*.pb.go`, `*.generated.ts`, `*.min.js`, `openapi.json` or `schema.graphql` output, `__snapshots__/*.snap`
  - a source schema or spec changed (`.proto`, OpenAPI YAML, GraphQL SDL, Prisma schema, SQLAlchemy models) next to large generated diffs
  - a `dist/` or `build/` directory committed
narrows_playbooks: true
escalates_with: [public-api, migration, data-write]
guide_refs:
  - "#endpoint-schema-changes-versioning-and-deprecation"
  - "#migrations-and-deployment-sequencing"
  - "#size-the-change-before-reading-it"
  - "#hand-the-mechanical-rules-to-tools"
tools: [pr-files-api, read-file, ripgrep, ci-results, agent-instructions]
bot_visibility: partial
```

### What it looks like in a diff

A big diff in files nobody writes by hand, next to a small diff in the source they come from.
The source diff is the change. The generated diff is its consequence.

### How to recognize it

Look at the file header or the path, and look for the generator's config or Make target. Check
whether the generated output corresponds to the source change in the same PR: a generated
change with no source change means the generator or its version changed.

### Likely intents

1. Regenerate after a schema change (the small source diff explains it).
2. Regenerate with a new generator version (large churn, source unchanged).
3. Update snapshots after a deliberate output change.
4. Commit a build artifact for deployment.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What is the source of truth? | Find the generator config and the source file | `read-file`, `ripgrep` for the generator's name, `agent-instructions` |
| Does regeneration reproduce the diff? | Re-run the generator | CI job if one checks generated files is stale: `ci-results` |
| Which version of the generator ran? | Compare headers and lockfile | `read-file` |
| Was anything hand-edited in a generated file? | Look for hunks that do not follow the generator's style | `read-file` |

### What not to spend review on

The generated output, if the source and generator explain it.

### Checklist

- **Review the source change**, not the output. The `.proto`, spec or model diff gets the full
  review under its domain's playbook, such as
  [endpoint schema changes](../../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation)
  or [migrations](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing).
- The generated output matches what the generator produces from the committed source, and a CI
  check enforces that. Hand-edited generated code is a finding.
- The generator version did not change inside a feature PR, or the change is separate.
- The generated diff matches the source diff in size and subject. A one-field schema edit that
  produces changes to forty unrelated messages points to a generator or ordering change.
- An autogenerated migration (Alembic `--autogenerate`, Django `makemigrations`) is reviewed
  as hand-written. The generator misses renames (it sees drop and add) and doesn't know about
  deployment order. Never assume it is mechanical.
- Snapshot updates agree with an intentional output change. A snapshot rewritten to match
  whatever the code now prints is a weakened test
  ([CMP-05](composite.md#cmp-05-tests-changed-to-match-new-behavior)).
- Generated artifacts are committed only when the repo's convention says so.

### How it combines with domain playbooks

It narrows them for the output and widens them for the source. A generated client is a public
surface, so a schema change in the source is a contract change.

### Red flags

- Generated files changed with no source change.
- Source change in a generated file only, which regeneration will erase.
- An autogenerated migration with a drop-and-add for a rename.
- Snapshot files updated by `-u` with no explanation.

### Worked example

An OpenAPI edit renames the query parameter `userId` to `user_id`. The regenerated TypeScript
client has 300 changed lines. The review skips them and comments on the spec: this is a
breaking change for the existing clients and the old name is not accepted as an alias.

### ai-review-bot today

`isGeneratedFile()` in `src/diff-pack.ts` is the bot's only notion of generated code. It
matches seven lockfile names (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`,
`Cargo.lock`, `poetry.lock`, `go.sum`), files ending `.min.js`, and files ending `.snap`.
Those sort last in the prompt and don't count as cut input if they are truncated. Everything
else is treated as source: `_pb2.py`, `*.generated.ts`, `dist/`, OpenAPI output, `uv.lock`,
`Pipfile.lock` and `bun.lockb` are not recognized, and neither are header markers like "DO NOT
EDIT". Large generated diffs therefore use review budget and can push real source out. What it
would need: header and path rules for generated files, and a link from generated output to its
source.

### Eval seed

On a schema edit with a 300-line regenerated client, the review comments on the schema change's
compatibility and does not review the generated lines.

## MEC-08: Lockfile-only churn

```yaml
id: MEC-08
name: Lockfile-only churn
family: mechanical
aliases: [lockfile update, dependency refresh, pnpm install noise, regenerated lock, transitive bump]
signals:
  - changes to `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, `uv.lock`, `poetry.lock`, `Cargo.lock`, `go.sum` with no manifest change (`package.json`, `pyproject.toml`)
  - a manifest change with a lockfile diff far larger than the manifest implies
  - integrity hashes or resolved URLs changing across many packages
  - a lockfile format or version header changed
narrows_playbooks: true
escalates_with: [trust-boundary, public-api]
guide_refs:
  - "#new-dependencies"
  - "#configuration-files"
  - "#least-privilege-and-trust-boundaries"
tools: [pr-files-api, read-file, ripgrep, ci-results, agent-instructions]
bot_visibility: partial
```

### What it looks like in a diff

Thousands of changed lines in a file nobody writes. A manifest diff of one or two lines
accompanies them, or none does.

### How to recognize it

Compare the lockfile diff to the manifest diff. If the manifest changed one dependency, the
lockfile should change that package and its subtree. A lockfile diff with no manifest change is
either a refresh (`pnpm update`, `uv lock --upgrade`) or an accident.

### Likely intents

1. Add or bump one dependency (small manifest diff, matching lockfile subtree).
2. Refresh in-range versions on purpose.
3. A format change from a different package manager version.
4. An accident: someone ran an install with a different tool version, registry or OS.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Which packages changed version, and in which direction? | Summarize the lockfile diff by package | `read-file` at base and head |
| Does the manifest justify it? | Compare to `package.json` / `pyproject.toml` | `pr-files-api`, `read-file` |
| Did resolved sources change (registry URL, git source)? | Search the diff for resolved URLs | `ripgrep` |
| Did the package manager version change? | Lockfile header; pinned version in `packageManager` or CI | `read-file`, `agent-instructions` |
| Are there advisories on new versions? | Audit | `ci-results` if CI runs an audit job |

### What not to spend review on

The text of the lockfile, line by line. Summarize it by package.

### Checklist

The guide asks that the lockfile diff be reviewed, "not skimmed", and that unexpected
transitive changes get a question
([new dependencies](../../Code-Review-Guide-and-Playbooks.md#new-dependencies)). Reduced to
checks:

- Every changed top-level package is explained by the manifest or by an intentional refresh.
- Downgrades and major-version jumps in transitive packages are noted and have a reason.
- New transitive packages are expected. A small direct dependency that pulls in many is a
  question for the dependencies playbook.
- Resolved sources are the usual registry. A package moved to a git URL, a tarball or a
  different registry is a trust-boundary finding.
- Integrity hashes changed only where versions changed. A hash change for the same version is
  suspicious.
- The lockfile belongs to the tool the repo uses (this repo uses pnpm), not a second one.
- A lockfile-only PR says it is a refresh, and CI passes on it.

### How it combines with domain playbooks

It narrows them to the dependencies playbook. The security question is the supply chain.

### Red flags

- A lockfile diff with no manifest change and no explanation.
- A package source changed to a fork or URL.
- Two lockfiles from different package managers.
- Many unrelated packages upgraded in a feature PR, which should be split out
  ([CMP-02](composite.md#cmp-02-cleanup-pr-that-is-really-several-prs)).

### Worked example

A PR bumps `zod` in `package.json` and `pnpm-lock.yaml` changes 2,400 lines. Grouping the diff
by package shows `zod` and about 40 packages from an unrelated `pnpm update`. The review asks
to split the refresh out, and notes that `esbuild` moved across a major version.

### ai-review-bot today

`isGeneratedFile()` recognizes `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`,
`Cargo.lock`, `poetry.lock` and `go.sum`. They sort last and are cut first, which spares the
budget. `uv.lock`, `Pipfile.lock`, `composer.lock`, `Gemfile.lock` and `bun.lockb` are not
recognized and are treated as source. Nothing summarizes a lockfile diff by package or checks it
against the manifest, and resolved-source changes pass unseen when the patch is cut. If
`classifyTier()` counts lockfile lines toward its 500-line threshold, a refresh would be routed
to the complex tier; that should be verified.

### Eval seed

On a one-dependency bump whose lockfile also moves an unrelated package to a git URL, the review
flags the source change and asks to split the refresh.

## MEC-09: Vendored code update

```yaml
id: MEC-09
name: Vendored code update
family: mechanical
aliases: [vendor update, third_party sync, bundled library bump, copied-in dependency, subtree update]
signals:
  - changes under `vendor/`, `third_party/`, `external/`, `deps/` or `lib/` holding a copy of an upstream project
  - a changed license header or version comment at the top of copied files
  - a large patch in a directory that has its own upstream README or `VERSION` file
  - skills or prompt files copied from another repository, where the upstream path is named in a header (this repo's `skills/`)
narrows_playbooks: true
escalates_with: [trust-boundary, public-api, auth]
guide_refs:
  - "#new-dependencies"
  - "#least-privilege-and-trust-boundaries"
  - "#size-the-change-before-reading-it"
  - "#configuration-files"
tools: [pr-files-api, read-file, ripgrep, ci-results, linked-work-item]
bot_visibility: none
```

### What it looks like in a diff

A large patch in a directory the team doesn't author, usually with a version string or upstream
commit hash changed. It sometimes arrives with local patches rebased on top.

### How to recognize it

The directory is named in a vendoring convention, or has its own `LICENSE`, `README` or
manifest. The diff matches the upstream diff between two versions.

### Likely intents

1. Upgrade the vendored library to a newer upstream release.
2. Apply a security patch from upstream.
3. Edit the local copy (carry a local patch). That is code the team owns now, and a change to
   it is not mechanical.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Which upstream versions are involved? | Read the version marker or hash before and after | `read-file` |
| Does the diff match upstream's own diff? | Compare against upstream's tag diff | not available from the PR alone; `linked-work-item` may name the release |
| What local patches exist? | Look for a patches directory or `LOCAL_CHANGES` note | `ripgrep`, `read-file` |
| What changed in the license? | Compare license files | `read-file` |
| Does anything call into changed APIs? | References into the vendored module | `ripgrep`, `lsp-references` |

### What not to spend review on

The upstream code itself, line by line. Review it at the release-notes level.

### Checklist

- The version marker moved, and the update is to a known upstream release, not an unreleased
  commit, unless that's stated.
- **Local patches survived.** A previous local fix lost in the update returns a fixed bug.
- The license is unchanged or still compatible, and notices were updated.
- Upstream's changelog was read for breaking changes, and callers in this repo were checked
  against them.
- No hand edits mixed into an "update" commit. Edits to vendored code go in a separate commit
  that is described as a local patch.
- New files in the vendored tree are expected: new transitive code, binaries and install
  scripts are suspicious.
- Whether to vendor at all is considered, since a package manager would give pinning and
  advisories ([new dependencies](../../Code-Review-Guide-and-Playbooks.md#new-dependencies)).

### How it combines with domain playbooks

It narrows them to the dependencies playbook for the copied code, and the trust-boundary
section applies if the code runs with privileges. In this repo, `skills/*.md` are vendored
prompt files, and a change to one changes what the agents do, which makes it a behavior change
even when copied.

### Red flags

- A local patch overwritten by the update.
- A binary or an install script added to the vendored tree.
- The update commit also edits first-party code.
- A vendored directory with no marker for its version.

### Worked example

`vendor/markdown-it/` moves from 13.0.1 to 14.0.0. The README says 14.0.0 drops a legacy
option. The review searches the repo for that option and finds one caller. It also notes the
local patch for table alignment from the previous update is missing, because the diff context
lines no longer contain it.

### ai-review-bot today

`isGeneratedFile()` doesn't recognize vendored directories, so a large vendored patch is
treated as source and reviewed line by line, using diff budget. The bot can't compare against
upstream or find local patches. What it would need: path rules for vendor directories, and the
upstream release notes.

### Eval seed

On a vendored library bump that drops a local patch, the review notes the lost patch and
doesn't comment on upstream code.

## MEC-10: Tooling config loosened

```yaml
id: MEC-10
name: Tooling config loosened
family: mechanical
aliases: [lint ignore added, strictness lowered, rule disabled, exclude path added, coverage threshold lowered]
signals:
  - '`ignore = [...]`, `per-file-ignores`, `exclude = [...]`, `select` shortened in `pyproject.toml` / `ruff.toml`'
  - '`"rules": { "x": "off" }` in `biome.json`, `.eslintrc` or `eslint.config.*`, `// eslint-disable`, `// biome-ignore`'
  - '`strict: false`, `noImplicitAny: false`, `skipLibCheck: true` added, or a `tsconfig` `exclude` growing'
  - '`[tool.mypy]` flags removed or `ignore_errors = true` for a module'
  - a coverage `fail_under` lowered, or paths added to the coverage omit list
  - '`# noqa`, `# type: ignore`, `@ts-ignore` waves in the same PR as code changes'
narrows_playbooks: false
escalates_with: [critical-path, trust-boundary, auth, public-api]
guide_refs:
  - "#configuration-files"
  - "#hand-the-mechanical-rules-to-tools"
  - "#explicit-over-implicit"
  - "#tests-levels-coverage-gaps-and-tdd"
tools: [read-file, ripgrep, ci-results, linked-work-item, agent-instructions]
bot_visibility: full
```

### What it looks like in a diff

A small edit to a config file, often one line, sometimes next to a code change that was failing
the rule. It can look like housekeeping.

### How to recognize it

Any change that makes a check pass more often: a rule removed, a path excluded, a threshold
lowered, a severity downgraded. The inverse (tightening) is the normal and welcome direction.

### Likely intents

1. A rule that is wrong for the project or has a false-positive class.
2. Silencing a rule to make this PR pass. The guide calls this the config equivalent of
   `# type: ignore` ([tooling config](../../Code-Review-Guide-and-Playbooks.md#configuration-files)).
3. A planned, staged adoption of a stricter rule (per-directory ignores that shrink over time).

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What failed before the change? | CI log on the base or the first push of the PR | `ci-results` |
| Which code is now exempt? | Resolve globs, list files | `ripgrep`, `read-file` |
| Is there a stated reason and plan? | Comment next to the ignore, ticket, description | `linked-work-item` |
| What does the rule protect? | Read the rule's documentation | `read-file` of the config and the rule docs |
| Do repo instructions forbid it? | Read the project's rules | `agent-instructions` |

### What not to spend review on

Code behind the exemption, which the loosened check no longer covers, deserves a manual look
for exactly what the check would have caught. That is not the same as reviewing it all.

### Checklist

- **The reason is stated and sufficient.** "Make CI pass" is not a reason; a rule that is wrong
  for this codebase is.
- **The exemption is as narrow as possible.** One file or one rule code, not a directory or the
  whole rule. A per-line ignore with a code beats a per-file ignore, which beats a global one.
- **The exemption is tied to a follow-up.** A comment or ticket says when it comes off.
- **The code that triggered it is looked at by hand**, since the tool no longer will. Does it
  contain the problem the rule exists for?
- **Security rules are not weakened.** Bandit and `S` rules, `no-eval`, `no-explicit-any` on a
  trust boundary, and CSRF or CORS lints stay on.
- **Coverage and test gates are not lowered** in the PR that adds untested code
  ([tests](../../Code-Review-Guide-and-Playbooks.md#tests-levels-coverage-gaps-and-tdd)).
- **Ignore waves are counted.** More than a handful of new `noqa` / `ts-ignore` markers in one
  PR points to an upstream config problem or a rushed change.

### How it combines with domain playbooks

It widens them. A loosened rule over auth code, input parsing or money handling pulls in the
corresponding playbook for the files it no longer covers.

### Red flags

- Config loosened in the same PR as the code that violated it.
- A global ignore added for one file's problem.
- `skip` / `exclude` on `tests/` or `migrations/` or `scripts/` without a reason.
- A rule dropped from `select` rather than ignored, which hides it from view.

### Worked example

A PR adds `"S608"` to Ruff's global `ignore` list, in the same commit as a new f-string SQL
query in `reports/export.py`. `S608` flags string-built SQL. The review blocks: the query
interpolates `filters` from the request, and the right change is a parameterized query with the
rule left on.

### ai-review-bot today

The config diff is fully visible, and an agent can read the ignore. What it can't see is which
code the exemption now covers or what CI reported before the change. `security-sast` may catch
the underlying injection if the code is in the diff, but nothing treats the config edit as a
signal in its own right. A loosening in `pyproject.toml` is a tooling file with no path
keyword for `classifyTier()`.

### Eval seed

On a PR that adds a security rule to a global ignore list alongside code that violates it, the
review flags the exemption together with the code it hides.
