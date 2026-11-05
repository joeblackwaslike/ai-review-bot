# What a code review is for

Finding defects is one aim of a review among several. Each aim below asks for a different
kind of output and a different capability, so the bot's design and its metrics have to cover
all of them, not only how many bugs it finds. These aims come from Joe's notes on first
principles (2026-11-04); the rest of this folder serves them.

| Aim | What a reviewer does | What the bot needs | Today |
| --- | --- | --- | --- |
| [Standards](#standards) | Checks the change against the language, team and company style guides | Linters for what a rule can state; repo and org rules for the rest | Partly |
| [Fresh eyes](#fresh-eyes) | Finds mistakes and missed opportunities the author can't see | The core review, with runbooks, context and verification | Yes, noisily |
| [Better design](#better-design) | Suggests a cleaner abstraction or approach, at any level of seniority | Suggestions that give the reasoning and a concrete alternative | Partly |
| [Codebase conventions](#codebase-conventions) | Keeps new code in the style the repo already uses | Search for sibling code that does the same thing, and compare | No |
| [Area knowledge](#area-knowledge) | Warns about the caveats and footguns of a part of the system | Past review threads, fixes and decisions on the same paths | No |
| [Knowledge transfer](#knowledge-transfer) | Teaches the author about the repo, the language and the systems | Explanations of why, with links to the guide and its language notes | No |
| [PR checklists](#pr-checklists) | Checks remaining work, integrations to test and the test plan | Task lists parsed from the PR body and compared with the diff and CI | No |
| [Team radar](#team-radar) | Uses open drafts to see who is working where and what overlaps | Overlap detection across open PRs, and a light review of drafts | No |

## Standards

Code should follow the language's style guide (PEP 8 for Python), the team's, and sometimes
a company-wide one. The guide's
[Hand the mechanical rules to tools](../Code-Review-Guide-and-Playbooks.md#hand-the-mechanical-rules-to-tools)
section already says how: anything a rule can state belongs in a linter, not in a reviewer's
comments. The bot's part is the rest, the conventions written in prose:

- read the repo's agent-instruction files with
  [`agent_instructions`](reviewer-tools.md#agent_instructions)
- take org-wide rules from the organization pack in [customization.md](customization.md)
- read linter and type-checker results through `ci_results`, rather than restating them

Today the bot sees a repo's written rules only when the PR edits the file that holds them.

### A strict linter is the strongest standard

The best standard is one a linter enforces before review ever happens.
[wemake-python-styleguide](https://wemake-python-styleguide.readthedocs.io/en/latest/) is the
model: a flake8 plugin whose rules (`WPS` codes) are strict on purpose. Many look excessive
on their own (limits on module members, expression complexity, argument counts), but each one
quantifies a design constraint. Code that is badly shaped fails the linter, and the author
has to restructure it to pass. Because it is a linter, the feedback is instant and arrives at
every commit, not days later in review. That applies to agents as much as to people: a strict
linter is one of the most effective ways to make an agent write better code.

Joe's [spinup-py](https://github.com/joeblackwaslike/spinup-py) project template enforces it
at every step. Generated projects set `format = wemake` and `select = WPS, E999` in
`setup.cfg`, run the `wemake-python-styleguide` hook in pre-commit, and run the same checks in
CI (`make check`). Exceptions are narrow and documented: `per-file-ignores` lists specific
codes for specific files, each with a comment saying why (test fixtures, `__init__.py`
re-exports).

Its sister template, [spinup-ts](https://github.com/joeblackwaslike/spinup-ts), ports as much
of wemake as TypeScript tooling allows. Biome handles formatting and the baseline rules, in the
role ruff plays for Python. ESLint runs the strict, opinionated rules through
`typescript-eslint` (its type-checked strict preset, in mypy's role), `eslint-plugin-unicorn`
(the closest equivalent to wemake's rewrite-forcing opinions), `eslint-plugin-sonarjs`
(complexity and duplication), `eslint-plugin-import-x` and `eslint-plugin-no-secrets`. Joe's
`joe-stack-preferences` skill keeps a rule-by-rule coverage matrix of WPS against ruff, Biome
and ESLint.

That matrix also lists the Python checks with **no TypeScript linter equivalent**, and those
are the ones a reviewer has to check by hand in TypeScript code:

| Python rule | Check | Why no linter catches it in TypeScript |
| --- | --- | --- |
| Ruff `FBT001`, `FBT003` (wemake's old `WPS425`) | Boolean positional arguments (the boolean trap) | No rule tells a boolean parameter from any other by position |
| `WPS430` | Nested functions | `no-inner-declarations` checks only declarations inside blocks, so neither a `function` nested directly in another function's body nor `const fn = () =>` is flagged |
| `WPS229` | A `try` body that covers too much | No rule measures what a `try` block wraps |
| Ruff `BLE001` | Catching too broadly | TypeScript has one untyped `catch` clause per `try`. With `useUnknownInCatchVariables` the variable is `unknown` and must be narrowed before use, but no rule checks that the handler narrows and rethrows what it doesn't handle |
| `WPS214` | Too many methods on a class | No ESLint rule counts class methods |
| `WPS202` | Too many functions and classes in one module | No ESLint rule counts a module's functions and classes |
| `WPS221` | Too complex a line (Jones complexity, counted over the line's syntax nodes) | ESLint's complexity rules work per function; cognitive complexity is only a proxy |

This is the deterministic and stochastic split from
[process-design.md](process-design.md#5a-direction-set-by-joe-one-reviewer-runbooks-and-tools)
in practice. Where a linter can enforce a rule, the reviewer trusts it. Where none can, the
rule becomes a checklist item in the reviewer's runbook for that language.

What this means for the review:

- **Trust the linter.** Read its result through `ci_results` and don't restate what it
  enforces. A clean run means the shape of the code already met the constraints.
- **Every weakening is a finding.** This includes a new `# noqa: WPS...`, a new
  `per-file-ignores` entry, a narrowed `select`, a removed or skipped pre-commit hook
  (`SKIP=`, `--no-verify` in scripts) and a CI step that stops failing the build. Each needs a
  stated reason that holds, typically a name forced by a third-party tool. "The rule is too
  strict" doesn't count. [MEC-10](operations/mechanical.md#mec-10-tooling-config-loosened)
  has the detection signals.
- **Agents push back on these rules.** They try to silence rules they find hard to satisfy,
  so a suppression in an agent-written PR gets the closest look. The fix is the
  restructuring the rule asks for. The reply should explain why the rule exists: wemake's
  documentation gives the reasoning for each violation, and that is the knowledge-transfer
  aim below. wemake now ships an agent skill
  ([`wps`](https://github.com/wemake-services/wemake-python-styleguide/blob/master/wemake_python_styleguide/.agents/skills/wps/SKILL.md))
  that states the same rules for the agent writing the code: fix the code, not the config;
  suppress only with a specific `# noqa: WPS###` when asked or when an existing
  `per-file-ignores` entry covers the line; leave the flake8 config alone without approval;
  delete a `noqa` once `flake8 --disable-noqa` shows it no longer fires. The reviewer
  enforces the same rules from the other side.
- **Where a repo has no strict linter, say so once.** Recommend one in the review summary,
  or through the org pack in [customization.md](customization.md), rather than enforcing its
  rules by hand in comments.

## Fresh eyes

A reviewer who didn't write the code sees what its author can't: a missed case, a wrong
assumption, a simpler way. This is the core review that the [operations](operations/) and
[domains](domains.md) catalogs and [process-design.md](process-design.md) describe. It works
today, but with low precision, because the bot reviews without context and doesn't verify
its claims.

## Better design

Review is where an author at any level hears "this is ad hoc here; with this abstraction the
code would be cleaner, more idiomatic and easier for others to work with." That feedback is
only useful with its reasoning attached. The guide's
[Writing the review](../Code-Review-Guide-and-Playbooks.md#writing-the-review) section asks
every design comment to name the principle and the cost and to offer a concrete alternative,
labeled `suggestion` so it doesn't block. The bot's design notes come today from an advisory
agent, with no fixed shape and no link to the principle behind them.

## Codebase conventions

Beyond written style guides, every repo has conventions: how errors are raised, how a
repository class is shaped, how tests are laid out, which helper everyone uses. Only someone
who works in the repo knows them, and new code that ignores them makes the codebase
inconsistent and harder to maintain. A reviewer checks this by comparing the change with the
code around it.

The bot needs a way to ask "how does this repo already do X?":

- find the closest existing code that does the same kind of thing: the sibling modules in
  the same package, other handlers of the same framework, other implementations of the same
  interface (`module_graph`, `implementations` and `search_text` in
  [reviewer-tools.md](reviewer-tools.md))
- compare the new code's shape with it, and flag a departure only where the existing pattern
  is consistent

Without repo access none of this is possible, and the bot can't tell an idiom of this repo
from a mistake.

## Area knowledge

People who have worked in a part of the codebase know its unwritten rules: the job that
mustn't run twice, the field that is null for old accounts, the vendor quirk. They make sure
a change handles them. For the bot, that knowledge exists in the repository's history:

- earlier review threads and the fixes that followed, on the same paths. The bot's own ledger
  already rebuilds threads, but only within one PR.
- commit messages and `blame` on the lines being changed
- ADRs, design docs and specs that mention the area, found through
  [`linked_work_item`](reviewer-tools.md#linked_work_item) and repo search
- `CODEOWNERS`, for who to ask

## Knowledge transfer

Review is also teaching. The author should come away knowing more about the repo, the
language and the systems they work in. For the bot, that means each finding explains why,
and links where the reader can learn more: the guide section it rests on, or the matching
Part 3 language note (for example
[TypeScript and JavaScript](../Code-Review-Guide-and-Playbooks.md#typescript-and-javascript)).
A finding that says only what to change teaches nothing.

## PR checklists

Many PR descriptions carry task lists: work still to be done before the PR is complete,
systems it integrates with that need testing, the test plan, scenarios for end-to-end,
acceptance or manual tests. The guide's
[PR description template](../Code-Review-Guide-and-Playbooks.md#appendix-pull-request-description-template)
includes one. A reviewer checks the list against the change.

Parsing is deterministic; judging is not. The bot can:

- parse the Markdown task lists in the PR body (`- [ ]` and `- [x]`), deterministically
- for each ticked item, gather candidate evidence from the diff and CI: a test that exists, a
  check that passed, the file that implements it. Whether that evidence satisfies the item's
  prose is the reviewer's call, so a ticked item with no convincing evidence is raised as a
  question, not asserted as false.
- for each unticked item, say whether the diff now appears to cover it, so the author can
  tick it
- list unticked items in the summary for the author to confirm. An unticked item blocks
  approval only when it is required work that remains undone. Rows that don't apply, optional
  items and author attestations are surfaced, not blocking.

## Team radar

A common habit is to open a draft PR as soon as work on a ticket starts: create the branch,
make the smallest commit, open the draft, and keep its description current with what's done
and what isn't. The open draft tells the team what you're working on, beyond what stand-up
covers. Anyone can see which files and which part of the system it touches, and whether that
overlaps with their own work, so two people don't build overlapping solutions that won't
merge. When there's overlap, the answer is a quick conversation or pairing.

The bot can serve this. Today it skips draft PRs entirely.

- **Overlap detection.** Compare the files, and where possible the symbols, a PR changes with
  the other open PRs and drafts in the repo, and note each overlap with a link. This needs
  only the GitHub API.
- **A light review for drafts.** On a draft, report progress against its checklist and any
  overlap, and save the full review for when it's marked ready. A draft is work in progress,
  and a full critique of it is noise.

## What this means for measuring the bot

[process-design.md](process-design.md) measures precision, recall, noise and cost on defects.
That covers fresh eyes and part of standards. The other aims need measures of their own:

- for checklists, whether the bot's ticked-but-unproven and covered-but-unticked calls match
  what reviewers concluded
- for overlap, whether the overlaps it reports turn out to be real
- for conventions and area knowledge, whether authors act on the finding
- for knowledge transfer, whether findings carry the reasoning and a link

The four missing capabilities are filed as beads ai-review-bot-t0c.48 (team radar), t0c.49 (PR checklists), t0c.50 (codebase conventions) and t0c.51 (area knowledge).
