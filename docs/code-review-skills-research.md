# Skill Recommendations: Claude LLM GitHub Code Review Bot

## Context

The project `/Users/joeblack/github/joeblackwaslike/ai-review-bot` is an empty repo being bootstrapped as a GitHub bot that uses Claude to perform automated code review on PRs. This document maps every installed skill relevant to GitHub code review across two dimensions: (1) skills the bot should invoke **during a review**, and (2) skills to use **while building the bot**.

---

## Skills Discovered

### `pr-review-toolkit` plugin (claude-plugins-official)

The most purpose-built collection for this use case. All live under `~/.claude/plugins/cache/claude-plugins-official/pr-review-toolkit/`.

| Skill | Type | Purpose |
|---|---|---|
| `pr-review-toolkit:review-pr` | command | Orchestrates the full review pipeline — dispatches any combination of the agents below, supports `--aspect all` or targeted flags |
| `pr-review-toolkit:code-reviewer` | agent | Bug detection, project guideline compliance, confidence-filtered output (80+ threshold = low noise) |
| `pr-review-toolkit:silent-failure-hunter` | agent | Finds swallowed exceptions, missing logging, inappropriate fallback behavior |
| `pr-review-toolkit:pr-test-analyzer` | agent | Test coverage gaps, missing edge cases, criticality-rated 1–10 |
| `pr-review-toolkit:type-design-analyzer` | agent | Type encapsulation/invariant ratings; makes illegal states representable |
| `pr-review-toolkit:comment-analyzer` | agent | Catches stale, misleading, or factually incorrect code comments |

### `git-pr-workflows` plugin (claude-code-workflows)

| Skill | Type | Purpose |
|---|---|---|
| `git-pr-workflows:git-workflow` | command | End-to-end git workflow: review → test → commit → branch → PR creation |
| `git-pr-workflows:code-reviewer` | agent | Comprehensive review with modern static analysis tools (SonarQube, CodeQL, Semgrep), performance analysis |

### `comprehensive-review` plugin (claude-code-workflows)

| Skill | Type | Purpose |
|---|---|---|
| `comprehensive-review:full-review` | command | 5-phase orchestrated review: quality → security → testing → best practices → report |
| `comprehensive-review:code-reviewer` | agent | AI-powered analysis, OWASP Top 10, language-specific expertise (8+ languages) |
| `comprehensive-review:architect-review` | agent | Architecture patterns, SOLID, DDD, cloud-native, C4 models |
| `comprehensive-review:security-auditor` | agent | Auth (OAuth2/OIDC), GDPR/HIPAA/SOC2, supply chain, network security |

### `security-scanning` plugin (claude-code-workflows)

| Skill | Type | Purpose |
|---|---|---|
| `security-scanning:security-sast` | command | Multi-language SAST with Bandit, Semgrep, ESLint Security, CodeQL; CI/CD integration patterns |
| `security-scanning:security-hardening` | command | 4-phase hardening: assessment → remediation → controls → validation |
| `security-scanning:sast-configuration` | skill | Semgrep/SonarQube/CodeQL config templates and false-positive management |

### `superpowers` plugin

| Skill | Type | Purpose |
|---|---|---|
| `superpowers:requesting-code-review` | skill | Protocol for dispatching code-reviewer subagents with proper context |
| `superpowers:receiving-code-review` | skill | Read → Verify → Evaluate → Respond loop; prevents blind acceptance |

### `claude-api` plugin (anthropic-agent-skills)

| Skill | Type | Purpose |
|---|---|---|
| `claude-api:claude-api` | skill | Anthropic SDK patterns: prompt caching, tool use, streaming, batches, error handling |

---

## External Marketplace Findings

Searched: [agentskills.io](https://agentskills.io), [agentskills.me](https://agentskills.me) (490 skills), [agentskillsfinder.com/category/code-review](https://agentskillsfinder.com/category/code-review) (25 skills), [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) (1000+ skills, 17K stars), [skillflow.builders](https://skillflow.builders) (500+), [aiagentskills.cc](https://aiagentskills.cc), [agent-skills.md](https://agent-skills.md), [lobehub.com skills marketplace](https://lobehub.com).

| Skill | Source | What makes it notable |
|---|---|---|
| `github-pr-review` | [moltenbits/ai-review](https://github.com/moltenbits/ai-review) | Creates pending **draft** reviews (not posted until human submits from GitHub UI). Batches all comments. ` ```suggestion ` blocks for one-click fixes. 5 parallel agents: SOLID, Security, Performance, Error Handling, Boundaries. P0–P3 severity + 80% confidence threshold. `--offline` mode for local staging. v2.0+ |
| `github-review-pr` | [feiskyer/claude-code-settings](https://github.com/feiskyer/claude-code-settings/blob/main/skills/github-review-pr/SKILL.md) | 5 parallel agents each reviewing from a different angle. Reads CLAUDE.md/AGENTS.md for project-standard compliance. Per-issue 0–100 confidence scoring with explicit rubric. Inline comments via `gh`. |
| `multi-pr-review` | [dyad-sh/dyad](https://github.com/dyad-sh/dyad/blob/main/.claude/skills/multi-pr-review/SKILL.md) | 3 agents with **randomized file ordering** to reduce ordering bias. Merge verdict (YES / NOT SURE / NO). Deduplicates findings against existing PR comments automatically. Always posts a summary even with no new issues. |
| `code-review` (GitHub Action) | [altinukshini/claude-code-pr-reviewer](https://github.com/altinukshini/claude-code-pr-reviewer) | Composite GitHub Action wrapping `anthropics/claude-code-action`. Supports Anthropic API, AWS Bedrock, and Vertex AI. `use_repo_skill: true` flag lets each repo supply its own `.claude/skills/code-review/SKILL.md`. Most complete drop-in reference architecture. |
| `cycle-review` | [axisrow/claude-code-review-cycle-skill](https://github.com/axisrow/claude-code-review-cycle-skill) | Full automated **review loop**: post review → poll bot response by comment ID → triage comments → apply fixes → repeat until approval → squash-merge. Hallucination detection (verifies reviewer claims against actual codebase). Contradiction handling across cycles. |
| `code-review-and-quality` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (20K ★) | 5-axis: correctness, readability, architecture, security, performance. Severity labels: Nit / Optional / FYI. Change sizing guidance (~100 lines). Companion skill: `security-and-hardening` (OWASP, three-tier boundary system). Most widely adopted reference set in the ecosystem. |
| `create-ai-reviewer` | [jclfocused/claude-agents](https://github.com/jclfocused/claude-agents/blob/main/skills/create-ai-reviewer/SKILL.md) | Generates a complete `claude-code-review.yml` GitHub Actions workflow. Dual mode: GitHub inline comments or Linear issue creation. |
| `code-reviewer` | [agentskills.me](https://agentskills.me/skill/code-reviewer) (obra/superpowers) | Handles both local diffs and remote PRs by number/URL. Correctness, maintainability, project-standard adherence. Clean integration point for interactive use. |
| `code-review-excellence` | [wshobson/agents](https://github.com/wshobson/agents) (also installed locally via `developer-essentials`) | Review mindset, prioritization, constructive tone. No scripts — pure guidance for producing high-signal reviews without style-nit noise. |

---

## Recommended Skill Set

### Tier 1 — Core (use on every PR review)

1. **`pr-review-toolkit:code-reviewer`** — Primary review agent. Confidence-filtered output reduces comment noise, which is critical for a bot that shouldn't spam.
2. **`pr-review-toolkit:silent-failure-hunter`** — Error handling is the most common production defect class; this catches what static analysis misses.
3. **`pr-review-toolkit:pr-test-analyzer`** — Test coverage gaps with criticality scores give actionable, prioritized feedback.
4. **`security-scanning:security-sast`** — SAST for every PR is the baseline security gate; integrates Semgrep/CodeQL which are GitHub-native.

### Tier 2 — Configurable (enable per repo or PR type)

5. **`pr-review-toolkit:type-design-analyzer`** — Enable for TypeScript/Python typed repos; skip for dynamic-language repos without types.
6. **`pr-review-toolkit:comment-analyzer`** — Enable for codebases with documentation standards; adds latency so gate behind config flag.
7. **`comprehensive-review:security-auditor`** — Enable for PRs touching auth, payments, PII, or infrastructure. Heavier than SAST alone.
8. **`comprehensive-review:architect-review`** — Enable only for PRs with large scope (schema changes, new services, API boundary changes).

### Tier 3 — Build-time (use while developing the bot itself)

9. **`claude-api:claude-api`** — Essential for implementing the Anthropic SDK integration: prompt caching (critical for review cost), tool use, streaming output to GitHub comments.
10. **`superpowers:requesting-code-review`** + **`superpowers:receiving-code-review`** — Meta-skills for the bot's own CI review loop during development.
11. **`security-scanning:sast-configuration`** — Configure Semgrep/CodeQL rules the bot will invoke as subprocess tools.
12. **`git-pr-workflows:git-workflow`** — Understand the PR lifecycle the bot hooks into (webhook events, diff fetching, comment APIs).

### Skip

- **`pr-review-toolkit:review-pr`** (command) — Designed as an interactive Claude Code command; the bot replaces this orchestration layer with its own GitHub webhook handler.
- **`comprehensive-review:full-review`** (command) — Same issue; the 5-phase interactive checkpoint flow doesn't map to async bot execution.
- **`security-scanning:security-hardening`** — Remediation-focused, not review-focused; wrong phase for a PR bot.
- **`git-pr-workflows:code-reviewer`** (agent) — Overlaps heavily with `pr-review-toolkit:code-reviewer`; keep one.

---

## Key Technical Notes

- **Prompt caching is mandatory** for a review bot — each PR diff reviewed against a system prompt means repeated context. The `claude-api` skill covers this.
- **Confidence filtering** (80+ threshold in `pr-review-toolkit:code-reviewer`) is the primary knob to control bot comment volume. Start conservative.
- **Agent dispatch pattern**: the bot's review handler should act as its own orchestrator, dispatching Tier 1 agents in parallel via the Anthropic API's tool use pattern, then merging outputs.
- **SAST subprocess pattern**: `security-sast` guidance shows running Semgrep/Bandit as subprocesses and feeding results to Claude for triage — the bot should adopt this hybrid approach.

---

## Optimal Composition

After comparing all internal and external skills, this is the set that composes most cleanly without redundancy.

### The orchestration pattern: adopt from `moltenbits/github-pr-review`

Don't use it as a runtime skill — it's designed for interactive Claude Code sessions. Use it as the **blueprint** for the bot's GitHub posting layer:

- **Pending draft reviews** — never post directly; always create a draft the human submits
- **Batch all comments** into one review object, not individual API calls
- **` ```suggestion ` blocks** for one-click fixes where the fix is unambiguous
- **P0–P3 severity taxonomy** with 80% confidence threshold as the output contract

This gives the bot a consistent, low-noise GitHub UX that survives across every agent that produces findings.

### The agent layer: 5 skills run in parallel

| Skill | Source | Why it's in and not cut |
| --- | --- | --- |
| **`pr-review-toolkit:code-reviewer`** | installed | Project-standard compliance (reads CLAUDE.md), confidence-filtered bugs. Moltenbits' agents don't read your coding standards — this one does. |
| **`pr-review-toolkit:pr-test-analyzer`** | installed | Test coverage gap analysis with criticality scores. Not covered by any other skill in this set. |
| **`pr-review-toolkit:silent-failure-hunter`** | installed | Error handling and swallowed exceptions. Moltenbits has an Error Handling agent but this one is deeper and more systematic. Overlap is acceptable because false negatives here are expensive. |
| **`security-scanning:security-sast`** | installed | Runs Semgrep/Bandit/CodeQL as **subprocesses** and feeds results to Claude for triage. This is qualitatively different from an LLM security agent — it catches known CVE patterns and injection vectors the LLM may miss. |
| **`addyosmani/code-review-and-quality`** | external (20K ★) | The 5-axis checklist (Nit/Optional/FYI) is the best available structured review framework. Complements rather than duplicates the P0–P3 severity taxonomy: axis labels map to priority, severity labels map to urgency. |

**Why not include `dyad:multi-pr-review` or `feiskyer/github-review-pr`?** Both are alternative orchestration patterns, not component agents. Their best ideas — randomized agent ordering, per-issue 0–100 confidence scoring, merge verdict, deduplication — are patterns to steal and implement in the bot's own merge layer, not separate skills to invoke.

### The merge layer: adopt patterns from `dyad:multi-pr-review`

After the 5 agents run in parallel, the bot's own merge step should:

1. Deduplicate findings across agents (same line, same issue type = one comment)
2. Resolve conflicts (e.g., agent A flags a pattern, agent B approves it) by taking the more conservative finding
3. Emit a merge verdict: **APPROVE / REQUEST_CHANGES / COMMENT** based on whether any P0 or P1 findings survived deduplication

### Build-time skills (developing the bot itself)

| Skill | Source | Purpose |
| --- | --- | --- |
| **`claude-api:claude-api`** | installed | Prompt caching (critical — system prompt is reused on every PR), tool use for structured output, streaming. |
| **`altinukshini/claude-code-pr-reviewer`** | external | Reference architecture for the GitHub Action wrapper — how to wire webhooks, handle diffs, post reviews. Study the implementation; don't run it as a skill. |

### What to skip and why

| Skipped | Reason |
| --- | --- |
| `pr-review-toolkit:type-design-analyzer` | TypeScript/Python-only; add as opt-in per repo config |
| `pr-review-toolkit:comment-analyzer` | Adds latency for marginal signal on a webhook bot; opt-in for repos with doc standards |
| `comprehensive-review:security-auditor` | Overlaps with `security-sast` + `code-review-and-quality` security axis; too heavy for every PR |
| `comprehensive-review:architect-review` | Right idea for large PRs but the interactive checkpoint model doesn't work in async webhook context |
| `moltenbits/github-pr-review` (as runtime skill) | Use as pattern source only; its orchestration model assumes interactive Claude Code |
| `axisrow/cycle-review` | Excellent for a loop-bot product but a separate use case from a one-shot review bot |

---

## Verification

After implementation, validate with:
1. Submit a test PR to a sandboxed repo and confirm webhook fires
2. Verify each Tier 1 skill produces output (no silent agent failures)
3. Check GitHub comment formatting (markdown renders, no JSON leaking)
4. Measure token usage per review; confirm cache hit rate > 80% on the system prompt
5. Submit a PR with a known SQL injection and verify `security-sast` catches it
