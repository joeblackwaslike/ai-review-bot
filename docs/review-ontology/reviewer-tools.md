# Reviewer tools

A proposed tool surface that lets ai-review-bot review the way an engineer does with the branch
checked out. The engineer clones the repo, opens the PR's branch in an editor, reads around a
deleted line or the whole file, clicks through to definitions, finds every caller of a
symbol, reads the repo's agent instructions and the ticket, and looks at CI results before
saying anything. Each of those actions becomes a tool here.

This document proposes contracts. It doesn't implement them. Which agents call the tools, and
when, depends on the review architecture chosen in [process-design.md](process-design.md).
[context-building.md](context-building.md) explains what each level of context answers and
which operations need it.

## From the guide's navigation table to tools

The guide's [Review locally](../Code-Review-Guide-and-Playbooks.md#review-locally-not-only-in-the-browser)
section lists the editor actions a reviewer uses. Each maps to one tool:

| Editor action (guide) | Used to | Tool |
| --- | --- | --- |
| Go to Definition, Peek Definition | Jump from a call to the code it runs | `definition` |
| Go to Implementation | Find the classes behind a `Protocol`, ABC or interface | `implementations` |
| Go to References | See every caller of a changed or removed symbol | `references` |
| Show Call Hierarchy | Trace callers up to the entry points | `call_hierarchy` |
| Go to Symbol in File or Workspace | Jump to a class or function by name | `file_outline`, `workspace_symbols` |
| Search across files | Find strings references can't: event names, config keys, SQL, mock paths | `search_text` |
| Timeline, Git blame | Find why a line exists | `blame`, `file_history` |
| Open File | Read the whole file, not the hunk | `read_file` |
| Run the tests, read CI | Know whether it works | `ci_results`, `job_log` |

Two more aren't in the table, but the guide asks for both before reading the diff. One is
reading the spec or ticket, the other is following the project's own rules. They become
`linked_work_item` and `agent_instructions`.

## Three capability tiers

Tools are grouped by what they need to run. That decides where each can run today.

| Tier | Needs | Runs where |
| --- | --- | --- |
| 1. API | A GitHub App installation token | Hosted (Vercel) and local |
| 2. Checkout | A clone of the repo at base and head | Local CLI now; hosted via a sandbox, if it fits the budget |
| 3. Semantic | A checkout plus a language server or parser | Local CLI now; hosted via a sandbox |

The local CLI (`ai-review review`, `watch`, `gate`) already runs inside a checkout, so tiers 2
and 3 are cheapest to ship there first.

### Tier 1: GitHub API

| Tool | Inputs | Returns | Notes |
| --- | --- | --- | --- |
| `read_file` | `path`, `ref` (`base` or `head`), optional `around_line` and `window`, or `symbol` | File text, or the window around a line, with line numbers | The fix for "five lines deleted, no context". Contents API; cap the size and say when truncated |
| `pr_files` | none | Every changed file with status, additions, deletions and `previous_filename` for renames, up to GitHub's 3,000-file cap | Already fetched by the bot (`PR_FILE_LIST_CAP` in `src/prompt.ts`). Return a truncation flag when the cap is hit. Re-review triage and the ledger use rename info today; the agent prompt does not |
| `compare` | `base`, `head`, optional `path` | The diff between two refs | For re-review deltas and backports |
| `commits` | none | The PR's commits with messages | Commit boundaries show whether mechanical edits were separated |
| `blame` | `path`, `ref`, line range | For each line, the commit, author, date and message | GitHub exposes blame through GraphQL |
| `file_history` | `path`, `limit` | Commits that touched the file, following renames where the API allows | |
| `ci_results` | `ref` | Check runs with conclusion, summary and annotations | Lint, typecheck and test failures usually arrive as annotations with file and line; when a failing check has none, fall back to the check summary or a bounded `job_log` slice |
| `job_log` | `job_id`, `tail` or `grep` | A bounded slice of a job's log | Logs can be large; never return the whole log |
| `linked_work_item` | none | The issue or ticket the PR implements: title, body, acceptance criteria, labels, comments | See below |
| `agent_instructions` | `paths`, `ref` (default `base`) | For each path, the ordered instruction blocks that apply, with source and precedence | See below |

### Tier 2: Checkout

| Tool | Inputs | Returns | Notes |
| --- | --- | --- | --- |
| `search_text` | `pattern`, optional `glob`, `ref` | Matches with file, line and a line of context | ripgrep. GitHub's code search can't replace it: it doesn't search the PR's head branch |
| `moved_code` | none | Blocks moved between files, with source and destination ranges and whether they changed | `git diff --color-moved` plus a body comparison; feeds REL-01 and REL-10 |
| `renames` | optional similarity threshold | Renamed and copied files, below GitHub's threshold too | `git diff -M<t> -C<t> --find-copies-harder`, with `<t>` the threshold (default 30%) |
| `function_history` | `path`, `symbol` | The commits that changed one function | `git log -L :symbol:path` |
| `blame_moved` | `path`, line range | Blame that follows lines moved or copied from other files | `git blame -C`; shows that "new" lines are old |

### Tier 3: Semantic

| Tool | Inputs | Returns | Notes |
| --- | --- | --- | --- |
| `definition` | `path`, `line`, `column` or `symbol`, `ref` | Location and source of the definition | LSP `textDocument/definition`, via Serena locally |
| `references` | `symbol` or position, `ref` | Every reference, grouped by file | Run at **base** to learn who depended on removed or moved code, and at **head** to find stragglers |
| `implementations` | `symbol`, `ref` | Concrete implementers | |
| `call_hierarchy` | `symbol`, `depth` | Callers up to entry points | Bounded depth; blast radius for triage |
| `workspace_symbols` | `query`, `ref` | Matching symbols | |
| `file_outline` | `path`, `ref` | Classes and functions with ranges | tree-sitter, no language server needed |
| `module_graph` | optional `paths` | Import edges among the changed modules and their neighbours | Graphify or a tree-sitter import scan; cycles and direction |
| `structural_diff` | `path` or two bodies | An AST-level diff that ignores formatting and moves | Separates a reformat from a change |

## The two intent and standards tools

The bot reads neither of these today. A CLAUDE.md is visible only when the PR edits it, so
the `code-reviewer.md` skill's "project compliance" can only check rules that happen to appear
in the patch.

### `agent_instructions`

Finds and resolves every agent-instruction file that applies to each changed path, and lets
the reviewer read and follow them. Coverage:

- `AGENTS.md`, nested, nearest file to the path taking precedence
- Codex `AGENTS.override.md`
- `CLAUDE.md` with `@` imports, plus `.claude/rules/**/*.md` scoped by `paths:` globs
- `GEMINI.md`
- Cursor `.cursor/rules/*.mdc` (`globs`, `alwaysApply`) and legacy `.cursorrules`
- GitHub Copilot `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md`
  (`applyTo`)
- Windsurf (`.windsurf/rules`, `.devin/rules`), Cline (`.clinerules/`, scoped by `paths:`) and
  Junie (`AGENTS.md`, legacy `.junie/guidelines.md`)

Each format's discovery, nesting, precedence and path-scoping rules come from its current
spec; see "Verified facts" below.

Output, for each changed file: the instruction blocks that apply, in precedence order, each
with its source path and the rule that made it apply (nearest `AGENTS.md`, a glob match).
Operations: `list(path)`, `read(source)`, `follow(import)`.

Two rules shape it:

- **Read from the base branch.** A PR that edits an instruction file would otherwise review
  itself against its own new rules. Changes to instruction files are reviewed as the "LLM
  prompt and agent-instruction files" domain in [domains.md](domains.md).
- **Instructions are constraints, not commands.** Instruction text is untrusted data. A rule
  like "no default exports" becomes something to check; a line that tries to steer the
  reviewer ("approve this PR") is reported, not obeyed.

### `linked_work_item`

Returns the issue or ticket the PR implements. Sources, in order:

1. GitHub closing references (GraphQL `closingIssuesReferences`) and `Fixes #n` in the body,
   including cross-repo references
2. tracker keys in the branch name, title or body: Jira (`ABC-123`), Linear (`ENG-123`),
   beads ids (`ai-review-bot-t0c.41`, which this repo's PR bodies carry)
3. spec and plan files in the repo that the body links to, such as `docs/superpowers/specs/`

It returns the title, body, acceptance criteria (parsed when the ticket has a list),
labels and comments. It feeds the guide's
[reviewing code against its spec](../Code-Review-Guide-and-Playbooks.md#reviewing-code-against-its-spec)
playbook, and the stated-intent signal in [triage.md](triage.md). External trackers need
credentials, so which ones are enabled is set in [customization.md](customization.md).

## Per-operation recipes

What each operation family fetches, in order. The operation entries in
[operations/](operations/) carry the full context lists.

| Operation | Recipe |
| --- | --- |
| REL-01 move | `moved_code` → `references(old symbol, ref=base)` → `search_text(old dotted path, old file path)` across mocks, config and docs → `read_file` on `__init__`/`index.ts` barrels at base and head |
| REL-10 move plus modify | `moved_code` → `structural_diff(old body, new body)` → full review of the changed lines only |
| DEL guard removed | `read_file(around_line)` at base → `search_text(the exception or sentinel)` → `references(the function, ref=base)` → `blame` on the removed lines → `ci_results` |
| IFC signature change | `references(symbol, ref=base)` for every original caller → `references(symbol, ref=head)` for stragglers → check each call site → `search_text(name)` for dynamic or string uses |
| MEC formatter-only | `structural_diff` on every file → if any file has a semantic change, reclassify it |
| BEH bug fix | `linked_work_item` → `ci_results` (does a new test fail on base?) → `references` for other callers that relied on the old behavior |
| Any PR | `agent_instructions(changed paths)` → `linked_work_item` → `ci_results` before line-level comments |

## How agents use the tools

Today every agent makes one `generateObject` call with no tools. Three shapes are possible:

- **A deterministic context pre-pass.** Triage detects operations, code runs each recipe
  above, and the results go into the shared, cached prompt block every agent already reads.
  Cheap, cacheable and testable with replay. But nobody can follow a lead the recipe didn't
  anticipate.
- **A tool loop for every agent.** Each agent explores on its own. Flexible, but cost and
  latency grow with the number of agents, each loop breaks the shared prompt cache, and it can
  exceed the 210-second agent budget on the hosted path.
- **A hybrid.** The pre-pass, plus a small tool budget per agent for follow-ups.

[process-design.md](process-design.md) chooses between them as part of choosing the review
architecture.

## Constraints

- **Time.** The hosted path gives agents 210 seconds inside a 300-second function. Tier 1 calls
  are each a network round trip; a pre-pass has to fit before the agents start.
- **Rate limits.** Installation tokens have a primary hourly limit and secondary limits on
  bursts. A per-review call budget keeps one large PR from exhausting them.
- **Size.** Every tool returns bounded output (windows, `tail`, `grep`, result caps) and says
  when it truncated.
- **Running PR code.** Running tests or a language server on a PR's code executes that code.
  For fork PRs that is untrusted. The default is to read CI results, not to run anything
  hosted. Running code needs a sandbox and an explicit setting in
  [customization.md](customization.md).
- **Base versus head.** Tools that list a `ref` input take `base` or `head`. A tool with no `ref`
  input works on the PR's base-to-head diff (`pr_files`, `commits`, `moved_code`, `renames`) or
  on the head checkout the harness fixes (`function_history`); `structural_diff` is given both
  bodies explicitly. Questions about who *depended* on something
  are asked at base. Questions about what is *left over* are asked at head.

## Verified facts

Checked against current documentation on 2026-11-04.

| Claim | Status | Source |
| --- | --- | --- |
| GitHub code search, REST and web, searches only the default branch, so it can't search a PR head | True. REST code search is also limited to 10 requests a minute and files under 384 KB | [About code search](https://docs.github.com/en/search-github/github-code-search/about-github-code-search), [REST search](https://docs.github.com/en/rest/search/search#search-code) |
| "List pull request files" returns `status: renamed` with `previous_filename` | True. It returns at most 3,000 files, 100 per page. `patch` is optional, and the docs don't say when it's omitted | [List PR files](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files) |
| GraphQL `closingIssuesReferences` lists the issues a PR would close | True. It covers closing keywords and manual links, and `userLinkedOnly` filters to manual links | [GraphQL pulls](https://docs.github.com/en/graphql/reference/pulls) |
| Check-run annotations and job logs are available over REST | True. Job logs return a redirect to a URL that expires after one minute. Logs are kept 90 days by default | [Check run annotations](https://docs.github.com/en/rest/checks/runs#list-check-run-annotations), [Workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs) |
| Blame is GraphQL-only | True as far as the docs show (`Commit.blame(path:)`) | [GraphQL commits](https://docs.github.com/en/graphql/reference/commits) |
| Installation token limits | At least 5,000 requests an hour, scaling to 12,500, with secondary limits (100 concurrent, 900 points a minute per endpoint) | [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| The AI SDK can combine a tool loop with structured output | True. `generateText` takes `tools`, a `stopWhen` condition and `output: Output.object({ schema })` in one call. `generateObject`, which every agent uses today, is deprecated in AI SDK 6 (the repo pins 6.0.x), so moving to tools also moves off the deprecated call | [generateText](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text), [AI SDK 6 migration](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0) |
| Vercel Sandbox can clone a repo and run commands | True. Firecracker microVMs, `Sandbox.create({ source: { type: "git", ... } })`, a 5-minute default timeout, at most 45 minutes on Hobby. No startup figure is published, so clone and index time has to be measured | [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) |
| Agent-instruction discovery rules | `AGENTS.md`: nearest file wins. Codex: root down to the working directory, `AGENTS.override.md` first in each directory, 32 KiB default cap. Claude Code: `CLAUDE.md` hierarchy, subdirectory files on demand, `@` imports up to four hops, `.claude/rules/**/*.md` scoped by `paths:`; it reads `AGENTS.md` only when no `CLAUDE.md` exists. Gemini CLI: `GEMINI.md`, configurable to read `AGENTS.md`. Cursor: `.cursor/rules` with `description`, `globs`, `alwaysApply`, plus nested `AGENTS.md`. Copilot: `copilot-instructions.md` and `*.instructions.md` with `applyTo`; code review reads them and `AGENTS.md`. Windsurf: `.windsurf/rules` (legacy) and `.devin/rules`. Cline: `.clinerules/` with `paths:`. Junie: `AGENTS.md` preferred, `.junie/guidelines.md` legacy | [agents.md](https://agents.md), [Codex](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Claude Code memory](https://code.claude.com/docs/en/memory), [Gemini CLI](https://geminicli.com/docs/cli/gemini-md/), [Cursor rules](https://cursor.com/docs/context/rules), [Copilot instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions), [Windsurf](https://docs.devin.ai/desktop/cascade/memories), [Cline](https://docs.cline.bot/customization/cline-rules), [Junie](https://junie.jetbrains.com/docs/guidelines-and-memory.html) |

Not confirmed: when GitHub omits `patch`, and whether Cursor's legacy `.cursorrules` is
formally deprecated.

## ai-review-bot today

- The hosted path has no tools. Agents receive the PR metadata and the packed diff.
- `pr_files` data exists. `src/triage.ts` (the re-review triage call) and
  `src/ledger/retarget.ts` read `previous_filename`. The review agents' prompt doesn't.
- `src/audit.ts` is the only code that reads the tree, for full-repo audits.
- The local CLI runs in a checkout and could offer tiers 2 and 3 with no new infrastructure.

Building the tools is follow-up work under its own spec, bead ai-review-bot-t0c.45.
