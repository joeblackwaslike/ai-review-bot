# Review False-Positive Guardrails — Design

## Problem

The review bot systematically generates a class of high-confidence **false positives** — findings it states as blocking (`high` severity) that are simply wrong. Verified examples from PRs #16/#17:

- **Can't-see-it hallucinations:** "`provider.responses()` doesn't exist and will throw" (it exists in the installed `@ai-sdk/openai`); "this `audit.ts → auth.ts` import pollutes the webhook bundle" (the import is `import type`, erased at compile time; and `audit.ts` isn't in the webhook graph).
- **Contradicts-the-diff recycling:** "`SEVERITY_LABEL` still exists" — asserted *after* the diff deleted it.

Root cause: each agent sees only the unified diff plus PR metadata — **not** the full repository, its dependencies, or `node_modules`. It cannot verify whether a library API exists or whether a symbol is still present elsewhere, so it fills the gap from (possibly stale) training knowledge and reports the guess as fact. The existing `≥80% confidence` instruction does not help because the model is *confidently wrong*.

## Approach

**Prompt calibration only** (chosen over a verification pass or context-feeding for cost/simplicity). Add explicit epistemic guardrails to the single shared system prompt so they apply to every agent (all Tier 1 + every Tier 2, both the webhook review path and the local `ai-review` CLI). The vendored `skills/*.md` frameworks are left untouched.

## Change

In `buildAgentSystemPrompt()` (`src/prompt.ts`), after the existing reporting rules (the `≥80% confidence` / severity lines), add an "Epistemic guardrails" block:

1. You see only the diff and PR metadata — not the full repository, its dependencies, or `node_modules`.
2. Do not claim a library/framework/SDK API, method, or option does not exist, is invalid, or will fail at runtime based on your own knowledge — your training data may be outdated and you cannot see the installed version. Raise a suspected API misuse as a **low-severity question**, never a blocking finding.
3. Do not assert that a symbol, import, function, or file exists or does not exist unless the diff shows it. If a finding depends on code not present in the diff, lower its severity or omit it.
4. A TypeScript `import type { … }` is erased at compile time and has no runtime effect — never flag a type-only import as a runtime or bundle concern.
5. `high` severity requires evidence visible in the diff itself; knowledge-based or speculative concerns are at most `low`, phrased as a question.

Rationale: 1–3 and 5 are general principles that address the whole "confidently asserts unseen things" class; 4 is the one concrete example worth hard-coding because the `import type` misread recurs with high confidence. General principles + one concrete example — not an overfit list.

## Out of scope (YAGNI)

No verification pass, no extra context-feeding, no per-skill edits, no changes to the recycling/triage machinery (PR1's domain). The guardrails reduce recycling indirectly by forbidding diff-contradicting assertions.

## Testing

- **Unit:** extend `src/prompt.test.ts` to assert the guardrail text appears in `buildAgentSystemPrompt()` output.
- **Live validation (post-merge):** after the fix deploys to prod, open a trigger PR whose diff deliberately recreates the past conditions — e.g. a call to a real-but-niche SDK method, a `import type` used only as a type, and a deletion of a symbol — and confirm the bot no longer raises the old `high`-severity false positives (at most low-severity questions). Compare against the documented prior behavior on #16/#17.
