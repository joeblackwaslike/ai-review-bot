# Building context

A diff is the smallest view of a change. A senior reviewer almost never judges a change from the
diff alone. They open the file around the hunk, jump to what a symbol means, ask who calls it,
read why it was written, and check what CI said. This file lists those levels of context, the
tools that reach each one, and which of them a bot can run where.

The tool ids used in the operation entries (`color-moved`, `lsp-references`, and so on) are defined
here. How an agent would call them (tool schemas, output limits, error shapes) is a separate
design question, covered in [reviewer-tools.md](reviewer-tools.md). This file says what each tool
is and what it costs.

The guide's section on
[reviewing locally](../Code-Review-Guide-and-Playbooks.md#review-locally-not-only-in-the-browser)
is the human version of this file. The mapping from its navigation table to tool ids is below.

## Context levels

Each level answers a question the one below it can't. Build upward only as far as the question
needs. Most hunks never need the top of the list.

| Level | Question it answers | Typical tools |
| --- | --- | --- |
| Hunk | What lines changed? | The diff itself |
| File | What else is in this file? What does the hunk sit inside? | `read-file`, `file-outline` |
| Symbol | What is this name? What does it call, and what shape does it have? | `lsp-definition`, `workspace-symbols`, `tree-sitter-diff` |
| Module graph | Who uses this, and what does it use? Does the dependency direction hold? | `lsp-references`, `lsp-call-hierarchy`, `lsp-implementations`, `module-graph` |
| Repo | Where else does this string, path or key appear, including places a language server can't see? | `ripgrep` |
| History | Where did this code come from, and why was it written? | `blame-C`, `log-L`, `log-follow`, `git-diff-M`, `color-moved` |
| Ticket or spec | What was the author trying to do? | `linked-work-item`, `pr-files-api` for spec files in the PR |
| Standards | What does this project require of code like this? | `agent-instructions` |
| CI results | What already failed, and where? | `ci-results` |

Two levels are easy to skip and expensive to omit. History tells you whether a block is a move
(and so already reviewed) or a guard someone added after an incident
([Chesterton's Fence](../Code-Review-Guide-and-Playbooks.md#readability-and-review) in the guide's
words). Standards tells you what "correct" means here; a repository's agent instruction files
may forbid a pattern the model would otherwise suggest.

## Tool reference

Each entry gives what the tool is, the exact command or API, what goes in and comes out, what it
costs, and where it can run.

Where it runs uses three levels:

- **Hosted**: the webhook path, with only the GitHub API and the diff.
- **Checkout**: a local clone of the repository at the base and head commits.
- **Checkout plus language server**: a clone with dependencies installed and a running LSP or
  equivalent index for the language.

Flags and endpoints were checked against the Git 2.56 manual pages on this machine and against
GitHub's REST description, difftastic's manual and the LSP 3.17 specification in November 2026.
Anything not checked is marked **unverified**.

### Diff-level tools

#### `color-moved`

Marks lines that appear removed in one place and added in another.

```bash
git diff --color=always --color-moved=zebra --color-moved-ws=allow-indentation-change <base>...<head>
```

- **Input.** Two commits.
- **Output.** A normal diff in which moved lines carry different colors from ordinary added and
  removed lines (`color.diff.oldMoved`, `newMoved`, and the `Alternative` variants). `zebra` alternates
  two colors so adjacent moved blocks stay distinguishable. A block is a run of at least 20
  alphanumeric characters. `--color-moved-ws=allow-indentation-change` lets a block count as moved
  when only its indentation changed (Git's manual lists this among the whitespace modes). The
  output is ANSI color, not structured data. Without `--color=always` there is no color when stdout
  is not a terminal.
- **Cost.** One diff pass, linear in diff size.
- **Where.** Checkout. A hosted equivalent has to be reimplemented on patch text (hash normalized
  lines, match runs of three or more); see [triage.md](triage.md#7-novel-versus-relocated-code).
- **Notes.** It detects text that moved within the diff. It can't see a rename of the symbol
  unless the body lines survive unchanged, and a body that changed in transit shows as unmoved
  lines at the changed spots.

#### `git-diff-M`

Rename and copy detection for whole files.

```bash
git diff -M -C --find-copies-harder --name-status <base>...<head>
git diff -M30% --stat <base>...<head>
```

- **Input.** Two commits. `-M[<n>]` detects renames, with a similarity threshold (default 50
  percent). `-C` also detects copies, and `--find-copies-harder` considers unmodified files as
  copy sources, which costs more.
- **Output.** Status lines such as `R092 old/path new/path`, where the number is the similarity.
- **Cost.** Similarity matching is quadratic in the number of added and deleted files. Git caps
  the exhaustive part with `diff.renameLimit` (default 1000 when unset, per the manual; `-l` on the
  command line overrides it).
- **Where.** Checkout. The hosted equivalent is `pr-files-api`, which reports renames GitHub
  already detected.

#### `blame-C`

Attributes each line to the commit that last changed it, following lines moved from other files.

```bash
git blame -w -M -C -C -C -L <start>,<end> <rev> -- <path>
git blame --line-porcelain -C -C -C <rev> -- <path>
```

- **Input.** A file at a revision, optionally a line range.
- **Output.** Per line, the commit, author and date. `--line-porcelain` gives the commit data
  for every line in a form a program can parse.
- **Cost.** One history walk. `-C` once detects lines moved from other files modified in the same
  commit. Twice, it also looks at the commit that creates the file. Three times, it looks in any
  commit, which is the slowest and the one that finds a symbol moved in an earlier commit.
  `-w` ignores whitespace-only changes when assigning blame. The numeric threshold (`-C<num>`)
  defaults to 40 alphanumeric characters.
- **Where.** Checkout. Not available hosted.
- **Notes.** Running it on the new file at head tells you the origin of lines the diff shows as
  added. If blame points at the same PR's commit, the lines are new; if it points at an older
  commit in a different file, they are a move.

#### `log-L`

History of one function or line range, through the commits that changed it.

```bash
git log -L :<funcname>:<path> <rev>
git log -L <start>,<end>:<path> <rev>
```

- **Input.** A function name (matched by the same hunk-header rules `git diff` uses, so it depends
  on the language's funcname pattern or a `diff=<driver>` attribute) or a line range, one file, and
  a single starting revision.
- **Output.** A patch series restricted to that range.
- **Cost.** A history walk with per-commit diffs. Slower than `git log -- <path>`.
- **Where.** Checkout.
- **Notes.** The manual says it can't be combined with pathspec limiters. It also does not
  implement the `--stat` family of formats. Whether it follows the function across a file
  rename is **unverified**; use `log-follow` to find the earlier path first, then run `-L` there.

#### `log-follow`

History of one file across renames.

```bash
git log --follow --name-status -- <path>
```

- **Input.** One path.
- **Output.** Commits touching the path, including those under previous names.
- **Cost.** A history walk with rename detection.
- **Where.** Checkout.
- **Notes.** The manual says it works only for a single file, and it is a heuristic. It can lose
  the thread on a file that was heavily edited while moving. The config key `log.follow` can make
  it the default for a single path.

#### `tree-sitter-diff`

A structural diff that compares syntax trees, not lines, so it ignores formatting and shows moved
or re-indented code as unchanged.

```bash
difft <old-file> <new-file>
git -c diff.external=difft diff <base>...<head>
```

- **Input.** Two files, or Git's external diff hook.
- **Output.** A human-oriented side-by-side display. `--exit-code` makes `difft` exit 1 when it
  finds syntactic changes (text files) or byte changes (binary files), which makes it usable as a
  yes/no check that two function bodies are equivalent after formatting. A machine-readable output
  mode is **unverified**; difftastic's manual that I checked doesn't document one as stable.
- **Cost.** More than a line diff, and highly variable. Whether and where it falls back to a
  line diff on very large inputs, and which options set the limits, is **unverified**; check
  `difft --help`.
- **Where.** Checkout. For hosted use, a tree-sitter binding (WASM, in Node) can compare
  two parsed bodies directly; that is a build, not a drop-in.
- **Notes.** Language coverage is whatever grammars the tool ships. Use it to compare two extracted
  function bodies (old at base, new at head), not whole files.

### Navigation tools (language server)

These are LSP 3.17 requests. Serena exposes equivalents as `find_symbol`,
`find_referencing_symbols` and `get_symbols_overview`; use whichever the runtime provides.

#### `lsp-definition`

`textDocument/definition`. Input: a file URI and a position. Output: the location(s) of the
declaration the symbol resolves to. One round trip, cheap. Needs the project's dependencies
installed so that third-party symbols resolve. Where: checkout plus language server.

#### `lsp-references`

`textDocument/references`. Input: a file URI, a position, and `context.includeDeclaration`.
Output: every location the server believes refers to the symbol. Cost: depends on index state, from
milliseconds on a warm index to tens of seconds on a cold start of a large project. Where: checkout
plus language server.

Run it at the **base commit** for what used to depend on a removed or moved symbol, and at **head**
for what depends on it now. Misses by design: string references (`mock.patch("a.b.c")`, config
keys, SQL, route paths, event names), dynamic access (`getattr`, `obj[name]`), and references in
languages the server doesn't cover. Cover those with `ripgrep`.

#### `lsp-call-hierarchy`

Three requests: `textDocument/prepareCallHierarchy` to get an item for a position, then
`callHierarchy/incomingCalls` (who calls this) and `callHierarchy/outgoingCalls` (what does this
call). Repeating `incomingCalls` walks to entry points. Support varies by server (a server may
advertise only some capabilities, per the LSP capability model); fall back to repeated
`lsp-references` filtered to call sites. Where: checkout plus language server.

#### `lsp-implementations`

`textDocument/implementation`. Input: a position on an interface, abstract method, `Protocol` or
base class. Output: the concrete implementations. Use it when a signature change on an interface
needs every implementer checked. Where: checkout plus language server.

#### `workspace-symbols`

`workspace/symbol`. Input: a query string. Output: matching symbols across the project, each with
a kind and location. Fuzzy matching is server-defined. Use it to find a moved symbol by name at
head, or to check that a name is no longer defined at the old location. Where: checkout plus
language server.

#### `file-outline`

`textDocument/documentSymbol`. Input: one file. Output: the classes, functions and members it
defines, with ranges. Cheap, and often possible without a full workspace index. Useful for
turning a hunk into the name of the enclosing function, for finding exported symbols, and for the
code-role classifier in [triage.md](triage.md#2-code-role). A tree-sitter query can do the same
job in a hosted environment, without type resolution. Where: checkout, or hosted with a parser
library.

#### `module-graph`

A graph of imports or dependencies between modules, computed ahead of time and queried.

- **Input.** The repository at a revision.
- **Output.** Nodes (modules or files) and edges (imports). Queries: in-degree (fan-in), shortest
  path, cycles, neighbors.
- **Examples.** Graphify, which this repository's tooling already uses for structural queries;
  for JavaScript and TypeScript, `madge` or `dependency-cruiser`; for Python, `grimp` or
  `import-linter`. The tool names are examples I haven't re-verified here.
- **Cost.** A parse of the whole tree to build. Cheap to query once built. Build it for the base
  and the head if you need to compare them.
- **Where.** Checkout. It does not need a language server, which makes it a cheaper way to get fan-in
  than `lsp-references` for every symbol.
- **Notes.** Import edges overstate coupling (an import used once) and miss runtime wiring
  (dependency injection, plugin registries, string-based imports).

### Text search

#### `ripgrep`

```bash
rg -n --fixed-strings 'billing.invoices.parse_line_items' <paths>
rg -n -g '!node_modules' -g '!*.lock' 'parse_line_items' .
```

- **Input.** A literal or a regular expression, optionally a path filter (`-g`) or file type (`-t`).
- **Output.** `path:line:text` matches. Honors `.gitignore` by default.
- **Cost.** Fast: a whole repository in well under a second for most projects.
- **Where.** Checkout. There is a hosted analogue in GitHub code search (below), with severe limits.
- **Notes.** Search the base checkout for what the old code was called, and the head checkout for
  what remains. Build the pattern set from the symbol's old dotted path, old file path, old import
  specifier and old name, and run it across the places an LSP doesn't read: tests' mock targets,
  config files, CI, Dockerfiles, docs, `CODEOWNERS`.

### File and PR data

#### `read-file`

A file at a revision, or a window around a line.

```bash
git show <rev>:<path>
```

or the GitHub contents API with a `ref`:

```text
GET /repos/{owner}/{repo}/contents/{path}?ref={sha}
Accept: application/vnd.github.raw+json
```

- **Output.** The file text. For the contents API, the raw media type returns the file body.
- **Cost.** One request per file hosted. Size limits per GitHub's documentation: files up to 1 MB
  support every feature; between 1 and 100 MB only the raw and object media types work; above
  100 MB the endpoint doesn't support the file. A directory listing is limited to 1,000 files.
- **Where.** Hosted and checkout.
- **Notes.** Read the same path at the base and the head SHA when comparing. Reading a window
  (the 40 lines around a hunk) costs less context than the whole file. It also finds the
  `import` block, decorators and class header that the hunk omits.

#### `pr-files-api`

```text
GET /repos/{owner}/{repo}/pulls/{pull_number}/files?per_page=100
```

- **Output.** One entry per changed file with `filename`, `status` (one of `added`, `removed`,
  `modified`, `renamed`, `copied`, `changed`, `unchanged`), `previous_filename` for renames,
  `additions`, `deletions`, `changes`, `sha`, `patch`, and URLs for the blob, raw file and
  contents. For binary files there is no `patch`.
- **Cost.** One request per page (30 by default; `per_page` is capped at 100). **The response
  includes at most 3,000 files**, so a very large restructure is cut short with no error.
- **Where.** Hosted. This is what `src/review.ts` fetches today.
- **Notes.** Rename detection here is GitHub's, so a renamed file with heavy edits can appear as
  one removal and one addition. The same file list shape comes from
  `GET /repos/{owner}/{repo}/compare/{base}...{head}`. When paginated, the compare endpoint shows
  the changed-file list only on the first page and caps it at 300 files for the comparison.

#### `ci-results`

Three calls, going from summary to cause.

```text
GET /repos/{owner}/{repo}/commits/{ref}/check-runs
GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations
GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs
```

- **Check runs.** Lists runs for a SHA, branch or tag with name, status and conclusion. GitHub
  limits the call to the 1,000 most recent check suites for the ref; for more, list check suites
  and then list runs per suite.
- **Annotations.** Per check run: `path`, `start_line`, `end_line`, `annotation_level`, `title`,
  `message`, `raw_details`. This is the form that maps directly to diff lines, and linters and type
  checkers that publish annotations make it the most reviewable output.
- **Job logs.** Returns a 302 redirect whose `Location` header is a download URL for plain text,
  and the link expires after one minute. Logs can be large; read the tail or search them.
- **Cost.** Three round trips for a failing run. Logs are the heavy part.
- **Where.** Hosted. Needs a token with read access to checks and Actions.
- **Notes.** The guide says to let CI go first. A failing check is context for the reviewer, and
  the bot shouldn't report what a red CI job already shows unless it adds the cause.

#### `linked-work-item`

The issue or ticket that the PR implements.

- **GitHub issues.** The PR body and title from the webhook payload, plus closing references: the
  GraphQL field `PullRequest.closingIssuesReferences` (present in the GitHub GraphQL schema,
  checked) returns the issues the PR will close. Then `GET /repos/{owner}/{repo}/issues/{number}`
  for the body.
- **Other trackers.** Parse the link in the PR template's "Spec / ticket" line. Fetching it needs
  the tracker's API and a credential the bot may not have.
- **Spec files in the PR.** The PR may add or change the spec itself (a path under `docs/` in
  `pr-files-api`); read it at head with `read-file`.
- **Cost.** One or two requests.
- **Where.** Hosted for GitHub issues and in-PR specs. Anything else is an integration.
- **Notes.** If there is no intent anywhere, say so and ask. The guide makes this the first
  comment.

#### `agent-instructions`

The project's own standards for code: `AGENTS.md`, `CLAUDE.md`, rule files and anything they
reference, that apply to the paths in the PR.

- **How to find them.** Walk up from each changed path to the repo root looking for `AGENTS.md` and
  `CLAUDE.md` in each directory, and read rule directories the root file names (for example
  `.claude/rules/`, `.cursor/rules/`). Precedence among nested files varies by tool; treat the
  nearest file as most specific. The exact set of file names and the merge rules are
  **unverified** for tools other than Claude Code and Codex.
- **Cost.** A few `read-file` calls, cacheable per repository per base SHA.
- **Where.** Hosted can read them with the contents API at the base ref. The hosted bot reads
  `CLAUDE.md` only if the PR's diff touches it.
- **Notes.** Read them at the **base** commit, not head. A PR that edits the instructions it is
  reviewed against would otherwise approve itself. Review a change to those files as a change to
  review policy.

### GitHub code search

Not a tool id, but a tempting hosted substitute for `ripgrep`. The REST search-code endpoint
(`GET /search/code?q=...`) searches the **default branch only** (so it can't see a PR's head),
only files under 384 KB, requires authentication, and is limited to 10 requests per minute. For a
review of a PR, it finds what exists on the base branch, which is the right answer for "who used
the old path before this change" and the wrong one for "what remains after it". Treat it as a
fallback for base-side lookups.

## Map from the guide's navigation table

The guide's table of VS Code actions, with the tool id that does the same job for an agent.

| Action | Shortcut (macOS) | Tool id | Notes |
| --- | --- | --- | --- |
| Go to Definition | Cmd+click, F12 | `lsp-definition` | |
| Open Definition to the Side | Cmd+Option+click | `lsp-definition` plus `read-file` | An agent has no layout. Read caller and callee into the same context. |
| Peek Definition | Option+F12 | `lsp-definition` plus `read-file` on a window | |
| Go to Implementation | Cmd+F12 | `lsp-implementations` | For `Protocol`, ABC and TypeScript interfaces |
| Go to References | Shift+F12 | `lsp-references` | Run at base for removed or moved symbols |
| Show Call Hierarchy | Shift+Option+H | `lsp-call-hierarchy` | Fall back to repeated `lsp-references` |
| Go to Symbol in File | Cmd+Shift+O | `file-outline` | |
| Go to Symbol in Workspace | Cmd+T | `workspace-symbols` | |
| Search across files | Cmd+Shift+F | `ripgrep` | The tool for strings references can't find |
| Go Back / Go Forward | Ctrl+- / Ctrl+Shift+- | none | An agent keeps its own trail of what it has read |

The guide's `charge()` example also names actions outside that table. Timeline and Git blame for
removed lines map to `blame-C` and `log-L`. Running the billing tests maps to running a test
command, which isn't one of these read-only tools; its output reaches the bot through `ci-results`
if CI ran it. Searching the branch for an exception name maps to `ripgrep`.

## Operation to tool recipes

Which tools to run, in what order, for each family. The relocation recipes come from the entries in
[operations/relocation.md](operations/relocation.md). The other families are in
[deletion](operations/deletion.md), [interface](operations/interface.md),
[behavior](operations/behavior.md), [mechanical](operations/mechanical.md) and
[composite](operations/composite.md); a recipe row here names the operation in words, and the entry
file has the id and the full checklist.

| Operation | Recipe, in order |
| --- | --- |
| Function or class moved (REL-01) | See the full recipe below |
| File moved or renamed (REL-02) | `pr-files-api` for `previous_filename`; `git-diff-M` if the similarity is borderline; `log-follow` on the new path; `ripgrep` for the old path in config, CI, Dockerfiles, docs and `CODEOWNERS`; `lsp-references` on exported symbols |
| Symbol renamed in place (REL-03) | `tree-sitter-diff` or a token comparison to confirm only the name changed; `lsp-references` on the new name against the base reference count; `ripgrep` for the old name in strings, docs and serialized keys; `read-file` on response models and DB mappings to see if the name is a wire name |
| Module split or merge (REL-04, REL-05) | `color-moved` per new or deleted file; `module-graph` at base and head for cycles; `lsp-references` per moved symbol; `ripgrep` for deleted module paths |
| Package restructure (REL-08) | `pr-files-api` (collapse pure renames); `ripgrep` per old directory prefix; `module-graph` before and after; check that the file list was not truncated at 3,000 |
| Extract or inline function (REL-06, REL-07) | `tree-sitter-diff` between the removed block and the new function; `lsp-references` for the number of callers |
| Move plus modify (REL-10) | `color-moved` to find the move; `tree-sitter-diff` on old and new body; `blame-C` to separate moved lines from edited ones |
| Code deleted | `lsp-references` at base for remaining callers, `ripgrep` for strings (event names, flags, config keys), `blame-C` and `log-L` on the removed lines for why they existed (Chesterton's Fence), `ci-results` for whether tests covered the removed behavior |
| File or module deleted | `lsp-references` for its exports, `ripgrep` for its path, `read-file` on barrel files, `__init__.py`, package `exports` and `CODEOWNERS` |
| Signature or public type changed | `lsp-references` at base for every caller, `lsp-implementations` for interfaces and protocols, `ripgrep` for the name in docs, client SDKs and OpenAPI files, `linked-work-item` for whether a breaking change was agreed |
| Field added, removed or renamed on a serialized type | As above, plus `read-file` on the migration directory and consumer schemas; `ripgrep` for the key in other services' code if they share the repository |
| Behavior changed (condition, limit, guard) | `read-file` window around the hunk; `lsp-references` for callers that relied on the old behavior; `lsp-call-hierarchy` up to the entry point to see who can reach it; `blame-C` on the old line for the reason; `ci-results` and tests changed in the PR |
| Formatting, import sort or lint autofix | `tree-sitter-diff` with `--exit-code` (or `git diff -w`) to confirm no syntax change; no further context |
| Dependency bump | `read-file` on the manifest and the lockfile diff; `linked-work-item`; changelog lookup, which is not one of these tools |
| Moves hidden in a larger change (composite) | Run the relocation recipe first, subtract the moved lines from the diff, then run the behavior recipe on what remains |
| Config key added or changed | `ripgrep` for the key across code, docs and deployment config; `read-file` on the loader and schema; `agent-instructions` for config conventions |

### Full recipe: REL-01, function or class moved

The example from [00-origin.md](00-origin.md#2-pattern-matching-in-the-diff). A function leaves
`billing/invoices.py` and appears in `billing/importer.py`, renamed or not.

1. **Detect the move.** `color-moved` over the PR range, or block-match removed against added lines
   on the patch. A run of lines marked moved from `invoices.py` to `importer.py` is a candidate.
   ```bash
   git diff --color=always --color-moved=zebra \
     --color-moved-ws=allow-indentation-change <base>...<head> -- billing/
   ```
2. **Confirm the body is unchanged.** Extract the old body (`git show <base>:billing/invoices.py`,
   cut to the function by `file-outline` ranges) and the new body, then compare with `difft
   --exit-code` or a normalized token comparison that ignores the symbol's own name. A difference
   turns the entry into REL-10.
3. **Find who used it at base.** `lsp-references` on the function at the **base** commit. If every
   reference is in `importer.py`, the intent is cohesion. Zero references from outside the old file
   and the new file means a pure move; references elsewhere mean the other callers need their
   imports updated.
4. **Find what still points at the old location.** On the **head** checkout, with `ripgrep`:
   ```bash
   rg -n -F -e 'billing.invoices.parse_line_items' \
        -e 'invoices import parse_line_items' \
        -e 'billing/invoices' .
   ```
   Run the same search across mocks (`mock.patch(...)`, `vi.mock(...)`), config files, CI,
   Dockerfiles and docs. An `lsp-references` pass at head covers the imports. The `rg` pass covers
   strings.
5. **Check history and intent.** `blame-C` on the new function at head to confirm it descends from
   the old one; `log-L` for the function's earlier history; `linked-work-item` for why it moved.
6. **Check visibility.** `read-file` on `billing/__init__.py` and `package.json` `exports` at
   base: was the old path public? If yes, a re-export is needed or the break is stated.
7. **Report.** Name the move, make no comments on the unchanged body, and list the stale
   references step 4 found.

The same recipe, in TypeScript: `export function parseLineItems` leaves `src/invoices.ts` for
`src/importer.ts`. Step 4 searches for `./invoices.js"`, `vi.mock("./invoices"`, and the old path
in `tsconfig.json` `paths`. Step 6 checks `index.ts` barrels and `package.json` `exports`.

## Feasibility

Where each tool can run on today's infrastructure.

### Hosted Vercel path

The webhook path runs inside one Vercel function. Facts from
[CLAUDE.md](../../CLAUDE.md) and `src/config.ts`:

- The route's `maxDuration` is 300 seconds on Vercel Hobby. The agents have a hard 210-second
  wall-clock budget (`REVIEW_AGENT_BUDGET_SECONDS`), leaving about 90 seconds for the summary
  call, the review POST and feedback writes.
- Agents run up to `AGENT_CONCURRENCY` at a time (default 4), after the first runs alone to write
  the prompt cache.
- Each agent makes one `generateObject` call with no tools. Adding tool use means several model
  round trips per agent inside the same 210 seconds.
- Tool results enter the prompt. Every file read adds to input tokens, and the diff is already
  capped at 200,000 characters.

What fits that budget:

| Tool | Hosted feasibility |
| --- | --- |
| `pr-files-api`, `read-file`, `ci-results`, `linked-work-item` | Yes. GitHub REST calls with the installation token, each in the tens to hundreds of milliseconds. Prefetch them in parallel before the agents start. |
| Block matching for moves, file kind and role classifiers, `file-outline` through a parser library | Yes, as in-process code on the patch text and fetched files. |
| `agent-instructions` | Yes, a few contents calls per review, cacheable by base SHA. |
| `ripgrep` over the repository | Only with a copy of the tree. GitHub's tarball endpoint (`GET /repos/{owner}/{repo}/tarball/{ref}`) can supply one; whether the download, extraction and search fit comfortably within the function's disk and time limits is **unverified** and should be measured on a real repository. |
| `git-diff-M`, `color-moved`, `blame-C`, `log-L`, `log-follow` | No. They need git history, which means a clone. A shallow clone has no history for blame. |
| `lsp-*`, `module-graph` | No in the function. A language server needs installed dependencies and a warm index. A precomputed index built by a CI job and fetched by the bot is the plausible hosted route; that is a design, not something that exists. |

GitHub limits that shape the design, from the REST description:

- `pr-files-api` returns at most 3,000 files, 30 per page by default.
- The compare endpoint lists at most 300 files when paginated.
- Contents: 1 MB for full-featured reads; directory listings cap at 1,000 files.
- Git trees: recursive listings cap at 100,000 entries or 7 MB.
- Code search: default branch only, files under 384 KB, 10 requests per minute.
- Job logs: a redirect link that expires after one minute.
- Primary REST rate limits for a GitHub App installation scale with the number of repositories and
  organization users (GitHub's documentation gives the formula and numbers; check it for the
  installed account). Secondary limits apply to bursts of requests; on `403` or `429` with
  `retry-after`, wait that many seconds.

Prefetch discipline: fetch everything that's cheap in parallel before the agents start and put the
result in the shared first prompt block, so the prompt cache covers it. That is how the diff is
shared today.

### Local CLI with a checkout

`ai-review review`, `watch` and `gate` run in a clone, so every tool above can run, subject to the
language server being installed for the project's language. Today the CLI feeds agents the same
serialized diff as the hosted path and doesn't use the checkout for navigation. The checkout is
where the full set of tools is feasible first, and it is the better place to prove the recipes work
before spending effort on the hosted equivalents. The local limits are wall-clock time per agent
and context growth from tool output, not API quotas.

### A practical order

1. Compute in-process, from the patch and the file list, everything that needs no repository:
   file kinds, moved-block detection, rename-aware packing, intent parsing.
2. Add GitHub-API context: head file windows, `agent-instructions`, `linked-work-item`,
   `ci-results`.
3. Add a checkout (local CLI first, hosted later) for `ripgrep` and the git history tools.
4. Add a language server or precomputed index for `lsp-*` and `module-graph`.

Each step unlocks a set of operation recipes without needing the next one. Steps 1 and 2 are
enough for the first stage of REL-01, REL-02, REL-03 and the file-kind half of triage. The
reference and string-search checks, which are the checks that matter most for a move, need step 3.
