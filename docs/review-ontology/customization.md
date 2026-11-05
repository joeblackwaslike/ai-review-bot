# Customization

How a repository or an organization changes the review: adding its own rules, switching
built-in ones off, scoping rules to paths, and choosing which tools and trackers the reviewer
may use. The goal is the control CodeRabbit, Greptile and Qodo PR-Agent offer, without anyone
editing prompts.

## What exists today

- `CUSTOM_REVIEW_PROMPT` is a single environment variable on the deployment. Every agent gets
  it under `## Custom Instructions`, for every repo the app is installed on
  ([configuration.md](../configuration.md)). It can't vary by repo or path.
- [greptile-parity-roadmap.md](../greptile-parity-roadmap.md), Phase 3, plans a cascading
  `.ai-review/` directory: `config.json` with a schema, `rules.md` for natural-language
  standards, context files, filters, and rule packs (`security`, `backend-api`,
  `frontend-react`, `database`, `tests`, `docs`, `agent-generated-code`). Nothing tracks it
  yet.

This document replaces Phase 3's loose rule-pack list with the ontology in this folder.

## One format for built-in and custom rules

The built-in pack is Joe's guide plus this folder:

- the guide's playbooks are the domain rules
- [operations/](operations/) holds the operation rules
- [triage.md](triage.md) holds the triage rules

An organization's pack and a repo's pack use the same shapes:

- **A playbook** is a heading, a "Leans on" line naming the principles, a "use when" condition
  (paths, domains or operations), and checks. That is the guide's own format, so a company
  with its own review guide can bring it nearly as written.
- **An operation rule** adds checks to an existing operation id (`REL-01`, `DEL-04`) or
  defines a new one with the [operation template](operations/_template.md).
- **Settings** are structured values: thresholds, globs, tool permissions.

Phase 3's rule packs map onto guide playbook groups. `backend-api` is the APIs group,
`database` is the data group, `tests` is the tests group, `docs` is documentation, and
`agent-generated-code` is the AI-generated code playbook. `frontend-react` has no guide
playbook yet; it is a proposed domain in [domains.md](domains.md).

## Extension points

| Layer | What a repo or org can do | Example |
| --- | --- | --- |
| Domains and playbooks | Add a playbook; disable or replace a built-in one; scope one to paths | A fintech adds a "money movement" playbook for `payments/**`; a repo with no database turns off the data playbooks |
| Operations | Add checks to an operation; add a new operation | "Moving anything under `packages/sdk/` keeps a re-export at the old path for one minor release" |
| Domain detection | Map paths to domains the detectors would miss | `services/ledger/**` is critical-path; `schema/**` is zod, not database |
| Triage | Always-deep paths, tier floors and ceilings, a cost cap per PR | Anything under `auth/` reviews at the deep tier |
| Context | Required context files; allowed reviewer tools; which instruction formats to honour; which ticket trackers to query and with what credentials | Always load `docs/adr/`; allow Jira lookups for `PAY-` keys; never run code in a sandbox |
| Output | Severity thresholds, label mapping, comment budget, ignore globs, which findings are advisory | Treat style findings as advisory; never comment on `generated/**` |
| Process | Which passes run, once [process-design.md](process-design.md) settles the architecture | Skip the test-gap pass on docs-only PRs |

## Zero-config first

Most repos that would install the bot already have agent instructions: `AGENTS.md`,
`CLAUDE.md`, Cursor rules, Copilot instructions. Reading those through the
[`agent_instructions`](reviewer-tools.md#agent_instructions) tool, before anyone writes
`.ai-review/` config, gives every repo project-specific review on install. Explicit config
comes second, for what instruction files can't express: thresholds, tool permissions,
trackers, disabling built-ins.

## Precedence

From lowest to highest:

1. built-in pack
2. organization config
3. repository root config
4. subdirectory config, for monorepos, nearest to the changed file wins

An organization can **lock** a setting so a repo can't loosen it. The obvious case is a
security floor: an org that requires the auth playbook on `auth/**` doesn't want a repo turning
it off. A locked setting can still be tightened.

## Trust

Configuration and instruction files are read from the **base branch**, not from the PR head.
Otherwise a PR can add `ignore: ["**"]` to `.ai-review/config.json` and review itself with
nothing. A PR that changes review configuration is itself reviewed, as the agent-instruction
domain in [domains.md](domains.md), and its new settings apply from the next PR on.

Rule text is data. A custom rule can tell the reviewer what to check; it can't tell the
reviewer to approve, to skip the PR, or to call a tool it isn't allowed to.

Most existing products choose the other way (see "Prior art"). They read config from the PR
head, so a config change takes effect in the PR that makes it. Greptile shows the middle
ground: it reads most of `greptile.json` from the head but its `autoApprove` setting from the
base. The design here goes further than that. Everything comes from the base, and an org can
lock settings. A repo that wants to preview a config change can run the local CLI against the
branch.

## Prior art

Checked against current documentation on 2026-11-04.

| Product | Config | What it offers | Branch it reads config from |
| --- | --- | --- | --- |
| [CodeRabbit](https://docs.coderabbit.ai/getting-started/yaml-configuration) | `.coderabbit.yaml` | `reviews.path_instructions` (glob plus instructions), `path_filters`, a review `profile` (quiet, chill, assertive), code-guideline files (it reads `AGENTS.md`, `CLAUDE.md`, Cursor and Copilot rule files), learnings | PR head |
| [Greptile](https://www.greptile.com/docs/code-review-bot/greptile-json) | `.greptile/` folder (cascading per directory) or `greptile.json` | `strictness` 1–3, `commentTypes`, `instructions`, `customContext` (rules, files, with optional scope globs), `ignorePatterns`, rules disabled by id | PR head for `greptile.json`, except `autoApprove` from base; not stated for `.greptile/` |
| [Qodo PR-Agent](https://github.com/qodo-ai/pr-agent/blob/main/docs/docs/usage-guide/configuration_options.md) | `.pr_agent.toml` | `extra_instructions` per tool, per-tool settings | Default branch, with a config-branch override |
| [GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/prompting/response-customization) | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | Repo-wide and path-specific (`applyTo`) instructions, `AGENTS.md`, `excludeAgent: "code-review"` to opt a file out | PR head |

What carries over: path-scoped instructions (all four), cascading per directory (Greptile),
reading the agent-instruction files a repo already has (CodeRabbit and Copilot), a single
strictness dial (Greptile, CodeRabbit), and opting a rule out of review specifically
(Copilot's `excludeAgent`).

## Out of scope

- **Learned rules.** Greptile and CodeRabbit learn from reviewer reactions and replies. The
  bot's improve corpus (`IMPROVE_ENABLED`, `finding_discards`, the feedback store) is where
  that would start. It needs its own design.
- **A settings UI.** Config lives in the repository.

## ai-review-bot today

One global `CUSTOM_REVIEW_PROMPT`. No per-repo config, no instruction-file loading, no path
scoping, no org layer. Building this is follow-up work under its own spec ("Repo and org
review customization", bead ai-review-bot-t0c.47), which supersedes the Phase 3 section of the parity roadmap.
