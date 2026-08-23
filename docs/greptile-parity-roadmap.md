# Greptile parity roadmap

This roadmap is for making `ai-review-bot` competitive with Greptile, using
[PR-Agent](https://github.com/The-PR-Agent/pr-agent) as the closest open-source reference point.
The goal is not to copy either product feature-by-feature. The goal is to reach the same buyer-visible
capability class: code reviews that understand the whole codebase, produce low-noise findings, learn
from team feedback, integrate into developer workflows, and prove their value with metrics.

## Current baseline

`ai-review-bot` already has a stronger review-agent core than a basic PR bot:

- Two independent GitHub Apps, one Anthropic-backed and one OpenAI-backed.
- Automatic and slash-command PR reviews.
- Five Tier 1 review agents plus conditional Tier 2 skills.
- Diff-anchor validation, cross-bot deduplication, idempotency, fallback comments, and full-repo audits.
- Feedback, improvement, trend, watch, and dashboard work already started in `src/feedback/`,
  `src/improve/`, `src/watch.ts`, and `dashboard/`.

The biggest gaps versus Greptile are not model choice. They are durable repository context, adaptive
noise control, user-facing controls, issue lifecycle tracking, and product-grade installation/analytics.

## Parity target

| Capability | Greptile reference | ai-review-bot target |
| --- | --- | --- |
| Whole-codebase context | Graph of files, functions, classes, dependencies, call sites, and similar patterns during review ([docs](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context)) | Persistent repo index with semantic search, symbol graph, call/reference lookups, and changed-symbol context packs injected into every agent |
| Review anatomy | Summary, confidence score, files/issues breakdown, diagrams, review counter, last-reviewed commit, inline severity badges, suggested fixes ([docs](https://www.greptile.com/docs/code-review/first-pr-review)) | Structured review summary with readiness score, severity taxonomy, file impact table, optional Mermaid diagrams, stable footer controls, and GitHub suggested changes |
| Team learning | Learns from PR comments, replies, reactions, and whether suggestions were addressed ([docs](https://www.greptile.com/docs/how-greptile-works/memory-and-learning)) | Feedback event store, addressed/not-addressed classifier, rule promotion, suppression memory, and per-repo/per-org reviewer tuning |
| Nitpick reduction | Suppresses ignored style/formatting patterns while never suppressing security/crash/data-loss issues ([docs](https://www.greptile.com/docs/how-greptile-works/nitpicks)) | Severity-aware noise filter with category budgets, cooldowns, dismissal memory, and hard floors for P0/P1 classes |
| Custom rules | `.greptile/` cascading config, rules, file references, filters, strictness, comment types, cross-repo context ([config docs](https://www.greptile.com/docs/code-review/greptile-config-reference)) | `.ai-review/` cascading config with schema validation, rule packs, include/exclude filters, severity thresholds, per-path overrides, and external context files |
| Cross-repo context | Repo clusters and `context.repos` for related repositories ([docs](https://www.greptile.com/docs/code-review/cross-repo-context)) | Read-only context repo clusters, explicit config references, shared package/API contract lookup, and org-level cluster suggestions |
| CLI reviews | Local branch review before push, instructions, resume, API key auth, sensitive-file guard ([docs](https://www.greptile.com/docs/code-review/greptile-cli)) | Local `ai-review review` for staged, unstaged, branch, and PR diffs; resumable runs; local cache; secret redaction; agent handoff |
| Fix with agent | Sends issue context to Claude Code, Codex, Cursor, Devin, etc. ([docs](https://www.greptile.com/docs/integrations/fix-with-your-agent)) | Copyable and deep-linkable fix prompts, `ai-review fix`, Codex/Claude/Cursor handoff, fix-all bundle, and auto-addressed comment tracking |
| Security review | Security-focused review with badges and preventative risky-pattern findings ([changelog](https://www.greptile.com/changelog)) | Dedicated security pass, CodeQL/Semgrep/Snyk-style signal ingestion, security badge, CWE mapping, exploitability/risk rationale |
| Auto-approve | Approves low-risk clean PRs under filters ([docs](https://www.greptile.com/docs/code-review/key-features)) | Optional GitHub review approval for clean 5/5 low-risk PRs, branch/author/path/label guardrails, and audit log |
| Analytics | PRs reviewed, merge time, addressed rate, critical bugs, reactions, filters, export ([docs](https://www.greptile.com/docs/analytics)) | Dashboard with review volume, finding precision, acceptance/addressed rate, false-positive trends, model cost, latency, and export |
| Platform surface | GitHub/GitLab app, teams/orgs, settings inheritance, auto-enable repos ([changelog](https://www.greptile.com/changelog)) | Start GitHub-only, then GitLab. Add org/team settings, inherited defaults, repo onboarding, installation health, and admin controls |

## Phase 0: Competitive benchmark harness

Build this before adding major features. Otherwise every phase optimizes by vibes.

Deliverables:

1. Create a benchmark corpus of 50-100 PRs across TypeScript, Python, Go, and mixed-stack repos.
2. Label expected findings by class: real bug, security, test gap, architecture, style, false positive.
3. Store each candidate finding with file, line, severity, evidence, fixability, and reviewer disposition.
4. Add a replay CLI: `ai-review bench run --corpus <path> --provider <provider>`.
5. Add scorer output: precision, recall on seeded bugs, duplicate rate, addressed-rate proxy, cost, latency.

Acceptance gate:

- A new model, prompt, rule, or graph retrieval change cannot be called better unless it improves at least one measured metric without regressing false-positive rate or duplicate rate.

## Phase 1: Product-grade PR review output

Make every review readable, triageable, and easy to act on.

Deliverables:

1. Normalize findings into a durable schema: category, severity, confidence, evidence, related symbols,
   suggested fix, duplicate key, and suppressibility.
2. Replace free-form summary composition with a deterministic review template:
   readiness score, top risks, changed files, issue table, inline comments, footer metadata.
3. Add Greptile-style severity labels:
   `P0` critical, `P1` high, `P2` medium, `P3` low/nitpick.
4. Emit GitHub suggested-change blocks when the fix is local and mechanically safe.
5. Add review counters, last-reviewed SHA, command hints, and stable hidden metadata.

Why first:

- Better output immediately improves usefulness and gives later memory/analytics code clean events to consume.

## Phase 2: Repository indexing and retrieval

This is the core parity gap.

Deliverables:

1. Build an indexer that runs on install, default-branch updates, and scheduled refresh.
2. Store file manifests, dependency edges, symbol declarations, imports/exports, call/reference edges where available,
   tests-to-source relationships, config/docs references, and embeddings.
3. Use Tree-sitter for broad syntax coverage, TypeScript compiler API for TS precision, and Pyright/Jedi or LSP-backed
   extraction for Python.
4. Add retrieval APIs:
   `getChangedSymbols`, `getCallers`, `getCallees`, `getSimilarPatterns`, `getRelatedTests`,
   `getArchitectureNeighbors`, `getConfigContext`.
5. Build context packs per finding agent, with token budgets and source attribution.

Acceptance gate:

- On benchmark PRs, agents must cite at least one relevant non-diff file for issues that depend on cross-file behavior.
- Duplicate and hallucinated findings must not increase when context is injected.

## Phase 3: Custom configuration and rule packs

Give teams control without requiring prompt editing.

Deliverables:

1. Add `.ai-review/config.json` with JSON schema and validation.
2. Add `.ai-review/rules.md` for natural-language standards.
3. Add `.ai-review/files.json` or equivalent for required context files and external docs.
4. Support cascading config in subdirectories for monorepos.
5. Add filters: labels, disabled labels, authors, branches, file globs, draft behavior, changed-file limits.
6. Add rule packs:
   `security`, `backend-api`, `frontend-react`, `database`, `tests`, `docs`, `agent-generated-code`.

Acceptance gate:

- A monorepo can set org-wide defaults at root and stricter rules under `api/`, `dashboard/`, and `infra/`.
- Rules are visible in review output when they affect a finding.

## Phase 4: Adaptive feedback and noise control

Turn existing feedback/improve work into the product differentiator.

Deliverables:

1. Persist feedback events from reactions, replies, dismissals, resolved threads, commit changes, and force reruns.
2. Classify outcomes:
   addressed, rejected, duplicate, not actionable, stale, false positive, accepted but not fixed yet.
3. Add suppression memory keyed by normalized claim, path pattern, rule, category, and repo.
4. Add promotion memory for high-value patterns that should be raised earlier.
5. Build thresholds:
   style/naming/doc suggestions can decay; P0/P1 security/data-loss/crash classes never fully suppress.
6. Feed repo-specific tuning into prompt construction and merge filtering.

Acceptance gate:

- Rejected findings in the same PR do not reappear on later commits unless new evidence appears.
- The dashboard can show false-positive trends by skill, model, category, and repo.

## Phase 5: Fix workflows and agent handoff

Make the bot not just a reviewer, but a repair coordinator.

Deliverables:

1. Add `ai-review fix <finding-id>` and `ai-review fix --all`.
2. Generate handoff prompts for Codex, Claude Code, Cursor, and generic agents.
3. Include file paths, line numbers, evidence, relevant context snippets, tests to run, and expected diff shape.
4. Track fix attempts by commit and mark comments addressed when touched files and LLM-as-judge evidence match.
5. Add optional GitHub issue creation for deferred larger fixes.
6. Add safe suggested patches for one-file mechanical changes.

Acceptance gate:

- A developer can go from review comment to local agent fix in one command.
- The PR summary updates addressed status after a follow-up commit.

## Phase 6: Security and runtime evidence

Greptile and CodeRabbit both sell trust. `ai-review-bot` needs evidence, not only comments.

Deliverables:

1. Add CodeQL/Semgrep ingestion and correlate static findings with AI review comments.
2. Add dependency and secret scanning inputs where available from GitHub APIs.
3. Add test/CI artifact ingestion: logs, failed tests, coverage reports, build output.
4. Add security-specific finding schema: CWE, sink/source, exploitability, preventative pattern, confidence.
5. Add optional sandboxed runtime smoke checks for small projects where CI instructions are discoverable.

Acceptance gate:

- Security comments include a concrete data/control-flow path or a cited static-analysis finding.
- Runtime/build/test comments quote or link the exact failing artifact that supports them.

## Phase 7: CLI parity and local developer loop

The CLI should become the fastest path for agentic development.

Deliverables:

1. Expand `ai-review` CLI modes:
   `review --staged`, `review --unstaged`, `review --branch main`, `review --pr <url>`, `review --resume`.
2. Add local repo index cache and offline redaction before sending context.
3. Add `--instructions`, `--config`, `--json`, `--sarif`, and `--fail-on P1`.
4. Add agent mode that prints or dispatches fix prompts.
5. Add GitHub Action parity for CI quality gates.

Acceptance gate:

- A Codex/Claude coding loop can run `ai-review review --staged --fail-on P1` before pushing and receive the same finding schema as PR reviews.

## Phase 8: Dashboard, org controls, and analytics

Make it operable by teams, not just Joe.

Deliverables:

1. Finish dashboard installation health, repo list, review history, and feedback trends.
2. Add org/team/repo settings with inherited defaults.
3. Add analytics:
   PRs reviewed, average review latency, cost, findings per PR, P0/P1 rate, addressed rate,
   rejection rate, duplicate rate, model/skill quality, and merge-time impact.
4. Add CSV/JSON export.
5. Add auto-enable repos, branch/path filters, and per-repo status.
6. Add admin-only API keys and audit log.

Acceptance gate:

- A repo owner can install, configure, inspect quality, and diagnose failures without reading Vercel logs.

## Phase 9: Multi-provider and multi-platform expansion

PR-Agent's durable advantage is provider/platform breadth. Add it after the GitHub product loop is solid.

Deliverables:

1. Convert hardcoded provider/bot config to a provider registry.
2. Add Gemini, OpenRouter, local/Ollama, and LiteLLM-compatible providers.
3. Add model routing by task, latency, cost, and benchmark performance.
4. Add GitLab support next; defer Bitbucket/Azure DevOps until GitHub/GitLab abstractions prove stable.
5. Package deployment modes:
   Vercel, Docker Compose, Kubernetes, and local webhook runner.

Acceptance gate:

- A self-hosted install can choose provider, model, and deployment mode without code changes.

## Phase 10: Auto-approve and merge-risk automation

Only do this once benchmark quality, suppression, and analytics are trustworthy.

Deliverables:

1. Add PR risk classifier based on changed files, ownership, test impact, dependency/security paths, and finding severity.
2. Add optional approval for clean low-risk PRs.
3. Add guardrails by branch, author, label, file path, repo, and required CI status.
4. Add signed audit trail for every auto-approval decision.
5. Add dry-run mode that reports would-have-approved for 2-4 weeks before enabling writes.

Acceptance gate:

- Auto-approve is off by default, dry-run first, and blocked by any P0/P1, failed required check, sensitive path, or missing benchmark confidence.

## Sequencing

| Horizon | Focus | Outcome |
| --- | --- | --- |
| 0-2 weeks | Phase 0 + Phase 1 | Reviews become measurable, readable, and stable enough to improve deliberately |
| 3-6 weeks | Phase 2 thin slice | Changed-symbol context, related tests, and similar-pattern retrieval improve real-bug recall |
| 7-10 weeks | Phase 3 + Phase 4 | Teams can tune behavior, and the bot stops repeating rejected/nitpicky findings |
| 11-14 weeks | Phase 5 + Phase 6 | Fix handoff, addressed tracking, security evidence, and CI artifact context close the action loop |
| 15-20 weeks | Phase 7 + Phase 8 | CLI + dashboard make the product usable outside one repo/operator |
| 21+ weeks | Phase 9 + Phase 10 | Provider/platform breadth and guarded auto-approval move from capable tool to competitive product |

## Non-goals until parity is real

- Do not optimize for more agents before improving context and feedback precision.
- Do not add more hosted platforms before GitHub review quality and lifecycle tracking are strong.
- Do not ship auto-approve until dry-run metrics show it would be boring.
- Do not use dashboard work as a substitute for benchmark and feedback loops.

## First five tickets to create

1. `benchmark-corpus`: Build replayable PR review benchmark and scoring CLI.
2. `finding-schema-v2`: Normalize findings, severity, confidence, evidence, suggestions, and stable IDs.
3. `repo-index-thin-slice`: Index TypeScript/Python symbols, imports, call sites, related tests, and semantic chunks.
4. `ai-review-config`: Implement `.ai-review/config.json`, `.ai-review/rules.md`, cascading lookup, and schema validation.
5. `feedback-suppression`: Suppress rejected duplicate findings within a PR cycle and across repo memory.

## Definition of Greptile parity

`ai-review-bot` reaches practical Greptile parity when a new team can install it on a GitHub org and get:

1. Automatic PR reviews with whole-repo and cross-repo context.
2. Inline comments with severity, evidence, suggested fixes, and low duplicate rate.
3. Configurable standards, filters, strictness, and path-specific overrides.
4. Learning from reactions, replies, addressed comments, and repeated dismissals.
5. CLI reviews before PR creation and agent handoff for fixes.
6. Security-focused review backed by static-analysis or code-path evidence.
7. Dashboard visibility into quality, cost, latency, adoption, and failure modes.
8. Optional guarded auto-approval for low-risk clean PRs.
