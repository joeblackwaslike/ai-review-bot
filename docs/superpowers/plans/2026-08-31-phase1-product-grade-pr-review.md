# Phase 1: Product-Grade PR Review Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the review schema with P0–P3 severity, category, confidence, evidence, and suppressible fields; then replace ad-hoc body assembly with a deterministic `formatReviewBody()` + readiness score + hidden metadata block.

**Architecture:** Two sequential PRs. PR 1 changes the schema and severity scale (all downstream maps, KV migration shim, skill prompts). PR 2 extracts body assembly into a pure `formatReviewBody()` function and adds readiness scoring and machine-readable metadata. PR 2 must not merge until PR 1 is on `main`, because the readiness score computation depends on P0–P3 being live.

**Tech Stack:** TypeScript ESM, Zod, Vitest, Biome. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-31-phase1-product-grade-pr-review.md](../specs/2026-08-31-phase1-product-grade-pr-review.md)

## Global Constraints

- TypeScript ESM: all imports use `.js` extensions on `.ts` source files.
- Named exports only — no default exports.
- `npm run typecheck` (tsc --noEmit) must pass clean before every commit.
- `npm run lint` (biome check) must pass clean before every commit.
- `npm run test` (vitest run) must pass clean before every commit.
- TDD: write the failing test first, run it to confirm RED, then write the implementation, run to confirm GREEN. Report the RED output in each step that describes it.
- No ASCII section-banner comments.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`).
- `effort: "low"` and `effort: "high"` in test files are model reasoning knobs — do NOT replace them when mass-renaming severity strings.

---

## ── PR 1: Schema + Severity ──────────────────────────────────────────────────

### Task 1: Severity scale rename — P0–P3

> All severity-keyed maps and rank tuples updated atomically with every severity string literal in the test suite so `tsc --noEmit` stays green throughout.

**Files:**
- Modify: `src/review.ts` (SEVERITY_LEVELS, SEVERITY_EMOJI, severityBadge, INLINE_SEVERITY_RANK, INLINE_OVERFLOW_RANK)
- Modify: `src/report.ts` (SEVERITY_EMOJI, countSeverities, frontMatter)
- Modify: `src/review.test.ts` — severity string literals
- Modify: `src/review-state.test.ts` — severity string literals (if any)
- Modify: `src/claim-dedupe.test.ts` — severity string literals (if any)
- Modify: `src/check-run.test.ts` — severity string literals (if any)
- Modify: `src/audit.test.ts` — severity string literals (if any)
- Modify: any other `src/*.test.ts` that hardcodes "high"/"medium"/"low" as a severity

**Interfaces:**
- Consumes: nothing new
- Produces: `Severity = "P0" | "P1" | "P2" | "P3"`, `SEVERITY_EMOJI`, `INLINE_SEVERITY_RANK`, `INLINE_OVERFLOW_RANK` — all keyed P0–P3. All downstream consumers pick these up via the exported type.

- [ ] **Step 1: Locate all severity literals in test files**

```bash
grep -rn '"high"\|"medium"\|"low"' src/*.test.ts | grep -v 'effort\|reasoningEffort\|"low".*effort\|effort.*"low"\|effort.*"high"\|"high".*effort'
```

Save the output — use it to verify all occurrences are replaced in Step 6.

- [ ] **Step 2: Write a failing test for the new severity scale**

Add to `src/review.test.ts` (near the `SEVERITY_LEVELS` tests):

```ts
it("SEVERITY_LEVELS tuple is P0–P3", () => {
  expect(SEVERITY_LEVELS).toEqual(["P0", "P1", "P2", "P3"]);
});

it("severityBadge maps P0 to 🔴 **P0**", () => {
  expect(severityBadge("P0")).toBe("🔴 **P0**");
});

it("severityBadge maps P1 to 🟠 **P1**", () => {
  expect(severityBadge("P1")).toBe("🟠 **P1**");
});
```

- [ ] **Step 3: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/review.test.ts 2>&1 | grep -A3 "P0–P3\|P0.*P0"
```

Expected: FAIL — "SEVERITY_LEVELS tuple is P0–P3" fails because it returns `["high","medium","low"]`.

- [ ] **Step 4: Update `src/review.ts` — severity constants**

Replace lines 249–299 (the `SEVERITY_LEVELS`/`Severity`/`SEVERITY_EMOJI`/`severityBadge` block):

```ts
export const SEVERITY_LEVELS = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

const SEVERITY_EMOJI: Record<Severity, string> = {
  P0: "🔴",
  P1: "🟠",
  P2: "🟡",
  P3: "🟢",
};

const UNKNOWN_SEVERITY_BADGE = "⚪ **Unknown**";

function severityBadge(severity: string): string {
  const emoji = SEVERITY_EMOJI[severity as Severity];
  if (!emoji) return UNKNOWN_SEVERITY_BADGE;
  return `${emoji} **${severity}**`;
}
```

- [ ] **Step 5: Update `src/review.ts` — rank maps**

Find and replace both rank maps (one at line ~516, one at ~1529):

```ts
// INLINE_SEVERITY_RANK (in mergeReviewsDetailed, sorts merged comments)
const INLINE_SEVERITY_RANK: Record<string, number> = {
  P0: 4, P1: 3, P2: 2, P3: 1,
};

// INLINE_OVERFLOW_RANK (in buildReview, cap at 50)
const INLINE_OVERFLOW_RANK: Record<string, number> = {
  P0: 4, P1: 3, P2: 2, P3: 1,
};
```

- [ ] **Step 6: Update `src/report.ts` — severity maps and front-matter**

Replace the `SEVERITY_EMOJI` map at line 30:

```ts
const SEVERITY_EMOJI: Record<string, string> = {
  P0: "🔴",
  P1: "🟠",
  P2: "🟡",
  P3: "🟢",
};
```

Replace `countSeverities` (lines 88–98):

```ts
function countSeverities(merged: ModelReview): {
  P0: number; P1: number; P2: number; P3: number;
} {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of merged.general_findings)
    counts[f.severity as keyof typeof counts] = (counts[f.severity as keyof typeof counts] ?? 0) + 1;
  return counts;
}
```

Replace the findings block in `frontMatter` (lines 122–126):

```ts
"findings:",
`  P0: ${c.P0}`,
`  P1: ${c.P1}`,
`  P2: ${c.P2}`,
`  P3: ${c.P3}`,
```

Also update the summary line in `formatReviewReport` (the `c.high · c.medium · c.low` text):

```ts
`Found **${total}** item(s): ${c.P0} critical · ${c.P1} high · ${c.P2} medium · ${c.P3} low. ` +
```

- [ ] **Step 7: Update all test severity string literals**

Run this substitution (safe because the grep filter in Step 1 excluded `effort` occurrences):

```bash
# severity: "high" → severity: "P1"
sed -i '' 's/severity: "high"/severity: "P1"/g' src/*.test.ts src/improve/*.test.ts

# severity: "medium" → severity: "P2"
sed -i '' 's/severity: "medium"/severity: "P2"/g' src/*.test.ts src/improve/*.test.ts

# severity: "low" → severity: "P3"  (only when it's a severity field, not an effort field)
# Use the more targeted form for "low":
sed -i '' 's/severity: "low"/severity: "P3"/g' src/*.test.ts src/improve/*.test.ts
```

After running, spot-check for any remaining `"high"/"medium"/"low"` that are severity (not effort):

```bash
grep -rn 'severity.*"high"\|severity.*"medium"\|severity.*"low"\|"high".*severity\|"medium".*severity\|"low".*severity' src/*.test.ts src/improve/*.test.ts
```

Expected: zero results.

Also update any inline occurrences in test `expect()` assertions like `toBe("high")` for severity checks — grep for them:

```bash
grep -n 'toBe("high")\|toBe("medium")\|toBe("low")' src/*.test.ts src/improve/*.test.ts | grep -v effort
```

Update any found with P1/P2/P3 as appropriate.

Also update `review-state.ts` `parsePriorReview` severity mapping (lines 72–74) — note this is NOT a test file but maps emoji → old severity string:

```ts
// OLD (do not leave this):
const severity = row[1] === "🔴" ? "high" : row[1] === "🟡" ? "medium" : "low";
// NEW: will be replaced properly in Task 3 — for now map to P1/P2/P3:
const severity = row[1] === "🔴" ? "P1" : row[1] === "🟡" ? "P2" : "P3";
```

(Task 3 adds 🟠 for P1 and moves P0 to 🔴 — do this interim fix now so the code compiles.)

- [ ] **Step 8: Run typecheck + tests**

```bash
npm run typecheck && npm test
```

Expected: all green. If typecheck fails, find remaining `"high"|"medium"|"low"` severity references and fix them.

- [ ] **Step 9: Commit**

```bash
git add src/review.ts src/report.ts src/review-state.ts src/*.test.ts src/improve/*.test.ts
git commit -m "feat: rename severity scale to P0–P3 with 🟠 badge for P1"
```

---

### Task 2: ModelReviewSchema new fields + testing factory defaults

**Files:**
- Modify: `src/review.ts` — `ModelReviewSchema` (add category, confidence, evidence, suppressible)
- Modify: `src/testing.ts` — `InlineCommentFixture`, `ModelReviewFixture`, `buildInlineComment`, `buildModelReview`

**Interfaces:**
- Consumes: `Severity` from Task 1 (P0–P3)
- Produces: `ModelReview` now carries `category`, `confidence: number`, `evidence: string`, `suppressible: boolean` on every finding and inline comment. All callers of `buildInlineComment()` and `buildModelReview()` get sensible defaults without changing their call sites.

- [ ] **Step 1: Write failing tests for new schema fields**

Add to `src/review.test.ts`:

```ts
it("ModelReviewSchema requires evidence to be non-empty", () => {
  const result = ModelReviewSchema.safeParse({
    event: "COMMENT",
    general_findings: [{
      title: "t", body: "b", severity: "P2",
      category: "bug", confidence: 0.9, evidence: "", suppressible: false,
    }],
    inline_comments: [],
  });
  expect(result.success).toBe(false);
});

it("ModelReviewSchema accepts a valid P0 finding", () => {
  const result = ModelReviewSchema.safeParse({
    event: "REQUEST_CHANGES",
    general_findings: [{
      title: "RCE", body: "details", severity: "P0",
      category: "security", confidence: 0.99,
      evidence: "src/auth.ts:42 — unsanitized input passed to exec()",
      suppressible: false,
    }],
    inline_comments: [],
  });
  expect(result.success).toBe(true);
});
```

You also need to export `ModelReviewSchema` from `review.ts` for the test to import it. Add `export` to the `const ModelReviewSchema` declaration.

- [ ] **Step 2: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/review.test.ts 2>&1 | grep -A5 "ModelReviewSchema requires evidence"
```

Expected: FAIL — the schema doesn't have these fields yet, so `evidence: ""` would pass (no min-length validation), and `safeParse` would succeed when it should fail.

- [ ] **Step 3: Update `src/testing.ts` — factory defaults**

Update the interfaces and factories:

```ts
// Add Category type (import or define locally in testing.ts)
type Category = 'bug' | 'security' | 'performance' | 'test-gap' | 'architecture' | 'style' | 'nitpick';

export interface InlineCommentFixture {
  title: string;
  body: string;
  path: string;
  line: number;
  start_line: number | null;
  suggestion: string | null;
  severity: Severity;
  category: Category;
  confidence: number;
  evidence: string;
  suppressible: boolean;
}

export function buildInlineComment(
  overrides?: Partial<InlineCommentFixture>,
): InlineCommentFixture {
  return {
    title: "Test finding",
    body: "Test body.",
    path: "src/file.ts",
    line: 2,
    start_line: null,
    suggestion: null,
    severity: "P2",
    category: "style",
    confidence: 0.8,
    evidence: "See diff.",
    suppressible: true,
    ...overrides,
  };
}

export interface ModelReviewFixture {
  event: "COMMENT" | "REQUEST_CHANGES";
  general_findings: Array<{
    title: string;
    body: string;
    severity: Severity;
    category: Category;
    confidence: number;
    evidence: string;
    suppressible: boolean;
  }>;
  inline_comments: InlineCommentFixture[];
}

export function buildModelReview(
  overrides?: Partial<ModelReviewFixture>,
): ModelReviewFixture {
  return {
    event: "COMMENT",
    general_findings: [],
    inline_comments: [],
    ...overrides,
  };
}
```

The `Category` type should be imported from `review.ts` once it is exported there. For now, define it inline in `testing.ts` and update the import once Step 4 exports it.

- [ ] **Step 4: Update `src/review.ts` — ModelReviewSchema new fields**

First, export the `Category` type above the schema:

```ts
const CATEGORY_VALUES = [
  "bug", "security", "performance", "test-gap",
  "architecture", "style", "nitpick",
] as const;
export type Category = (typeof CATEGORY_VALUES)[number];
```

Then update the `ModelReviewSchema`:

```ts
export const ModelReviewSchema = z.object({
  event: z.enum(["COMMENT", "REQUEST_CHANGES"]),
  general_findings: z.array(
    z.object({
      title: z.string(),
      body: z.string(),
      severity: z.enum(SEVERITY_LEVELS),
      category: z.enum(CATEGORY_VALUES),
      confidence: z.number().min(0).max(1),
      evidence: z.string().min(1),
      suppressible: z.boolean(),
    }),
  ),
  inline_comments: z.array(
    z.object({
      title: z.string(),
      body: z.string(),
      path: z.string(),
      line: z.number().int(),
      start_line: z.number().int().nullable(),
      suggestion: z.string().nullable(),
      severity: z.enum(SEVERITY_LEVELS),
      category: z.enum(CATEGORY_VALUES),
      confidence: z.number().min(0).max(1),
      evidence: z.string().min(1),
      suppressible: z.boolean(),
    }),
  ),
});
```

Note: `ModelReviewSchema` must now be `export const` (not just `const`) so tests can import it.

- [ ] **Step 5: Update `src/testing.ts` to import `Category` from review.ts**

```ts
import type { Category, Severity } from "./review.js";
```

Remove the local `Category` type definition.

- [ ] **Step 6: Fix any test files that construct raw finding objects without the new fields**

```bash
npm run typecheck 2>&1 | head -40
```

For each TypeScript error, add the missing fields using sensible values matching the `buildInlineComment` defaults (`category: "style"`, `confidence: 0.8`, `evidence: "See diff."`, `suppressible: true`). Tests constructing `general_findings` inline need the same treatment with appropriate values.

- [ ] **Step 7: Run all tests**

```bash
npm run typecheck && npm test
```

Expected: green. The new schema tests from Step 1 should now pass.

- [ ] **Step 8: Commit**

```bash
git add src/review.ts src/testing.ts src/*.test.ts
git commit -m "feat: extend ModelReviewSchema with category, confidence, evidence, suppressible"
```

---

### Task 3: KV migration shim + parsePriorReview update

**Files:**
- Modify: `src/review-state.ts` — `migrateSeverity()`, `loadReviewState()`, `parsePriorReview()`

**Interfaces:**
- Consumes: `PersistedFinding.severity` (was "high"/"medium"/"low", now P0–P3)
- Produces: `loadReviewState()` guarantees all returned `PersistedFinding.severity` values are P0–P3, regardless of what was stored. `parsePriorReview` handles the new 🟠 badge and maps all four emoji.

- [ ] **Step 1: Write failing tests for migration shim**

Create `src/review-state.test.ts` (or add to existing):

```ts
import { describe, expect, it, vi } from "vitest";
import { loadReviewState } from "./review-state.js";

describe("migrateSeverity shim", () => {
  it("maps old 'high' to P1 on KV read", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({
        lastReviewedSha: "abc123",
        event: "REQUEST_CHANGES",
        findings: [{ id: "1", path: null, line: null, title: "Bug", severity: "high", status: "open" }],
        reviewedAt: new Date().toISOString(),
      })),
      set: vi.fn(),
    };
    const state = await loadReviewState(kv as any, "anthropic", "o", "r", 1, null);
    expect(state?.findings[0].severity).toBe("P1");
  });

  it("maps old 'medium' to P2 on KV read", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({
        lastReviewedSha: "abc123",
        event: "COMMENT",
        findings: [{ id: "2", path: null, line: null, title: "Nit", severity: "medium", status: "open" }],
        reviewedAt: new Date().toISOString(),
      })),
      set: vi.fn(),
    };
    const state = await loadReviewState(kv as any, "anthropic", "o", "r", 1, null);
    expect(state?.findings[0].severity).toBe("P2");
  });

  it("maps old 'low' to P3 on KV read", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({
        lastReviewedSha: "abc123",
        event: "COMMENT",
        findings: [{ id: "3", path: null, line: null, title: "Style", severity: "low", status: "open" }],
        reviewedAt: new Date().toISOString(),
      })),
      set: vi.fn(),
    };
    const state = await loadReviewState(kv as any, "anthropic", "o", "r", 1, null);
    expect(state?.findings[0].severity).toBe("P3");
  });

  it("passes through P0–P3 values unchanged", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({
        lastReviewedSha: "abc123",
        event: "REQUEST_CHANGES",
        findings: [{ id: "4", path: null, line: null, title: "Critical", severity: "P0", status: "open" }],
        reviewedAt: new Date().toISOString(),
      })),
      set: vi.fn(),
    };
    const state = await loadReviewState(kv as any, "anthropic", "o", "r", 1, null);
    expect(state?.findings[0].severity).toBe("P0");
  });
});
```

- [ ] **Step 2: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/review-state.test.ts 2>&1 | grep -A3 "maps old"
```

Expected: FAIL — `loadReviewState` returns `"high"` not `"P1"` (no shim yet).

- [ ] **Step 3: Add `migrateSeverity` and update `loadReviewState`**

In `src/review-state.ts`, add before `loadReviewState`:

```ts
const SEVERITY_COMPAT: Record<string, string> = {
  high: "P1",
  medium: "P2",
  low: "P3",
};

function migrateSeverity(s: string): string {
  return SEVERITY_COMPAT[s] ?? s;
}
```

In `loadReviewState`, after the `isReviewState(parsed)` check, add severity migration:

```ts
if (isReviewState(parsed)) {
  // Migrate legacy severity strings from pre-Phase-1 KV records
  for (const f of parsed.findings) {
    f.severity = migrateSeverity(f.severity);
  }
  return parsed;
}
```

- [ ] **Step 4: Update `parsePriorReview` badge regex and severity mapping**

Replace lines 71–74 in `parsePriorReview`:

```ts
// Match P0 (🔴), P1 (🟠), P2 (🟡), P3 (🟢) — P0 maps to P1 from old reviews
// since pre-Phase-1 reviews had no P0; the highest badge was 🔴 meaning "high"→P1.
const BADGE_TO_SEVERITY: Record<string, string> = {
  "🔴": "P1",  // legacy: old reviews used 🔴 for "high"; no P0 in old bodies
  "🟠": "P1",  // P1 badge (only emitted after Phase 1 lands)
  "🟡": "P2",
  "🟢": "P3",
};
const row = line.match(/^\|\s*(🔴|🟠|🟡|🟢)\s*\|\s*(.+?)\s*\|$/);
if (!row) continue;
const severity = BADGE_TO_SEVERITY[row[1]] ?? "P3";
```

Remove the old `const severity = ...` ternary.

- [ ] **Step 5: Run tests**

```bash
npm run typecheck && npm test -- src/review-state.test.ts
```

Expected: all four migration tests green.

- [ ] **Step 6: Commit**

```bash
git add src/review-state.ts src/review-state.test.ts
git commit -m "fix(review-state): migrate legacy high/medium/low severity on KV read"
```

---

### Task 4: Badge pattern update in `improve/findings.ts`

**Files:**
- Modify: `src/improve/findings.ts` — `BADGE_PATTERN`, add `BADGE_TO_SEVERITY`

**Interfaces:**
- Consumes: badge strings emitted by `severityBadge()` (now uses 🟠 for P1)
- Produces: `parseFindingComment()` recognizes 🟠 and maps all four emoji to P0–P3 severity strings

- [ ] **Step 1: Write failing test**

In `src/improve/findings.test.ts` (or create it):

```ts
import { describe, expect, it } from "vitest";
import { parseFindingComment } from "./findings.js";

it("parseFindingComment recovers severity P1 from 🟠 badge", () => {
  const body = "🟠 **P1**\n\n**Unsafe eval**\n\nDetails here.";
  const result = parseFindingComment(body);
  expect(result).not.toBeNull();
  expect(result?.severity).toBe("p1");
});

it("parseFindingComment recovers severity P0 from 🔴 badge", () => {
  const body = "🔴 **P0**\n\n**RCE**\n\nDetails.";
  const result = parseFindingComment(body);
  expect(result?.severity).toBe("p0");
});
```

Note: `parseFindingComment` lowercases the badge label — `"P1".toLowerCase()` → `"p1"`. The tests assert the lowercased form.

- [ ] **Step 2: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/improve/findings.test.ts 2>&1 | grep -A3 "recovers severity"
```

Expected: FAIL — the 🟠 badge is not in the pattern, so `parseFindingComment` returns `severity: null`.

- [ ] **Step 3: Update `BADGE_PATTERN` in `src/improve/findings.ts`**

Replace line 13:

```ts
// OLD:
const BADGE_PATTERN = /^(?:🔴|🟡|🟢|⚪)\s+\*\*([A-Za-z]+)\*\*\s*\n+/;

// NEW: add 🟠 (P1) and allow digits in the badge label (P0, P1, P2, P3)
const BADGE_PATTERN = /^(?:🔴|🟠|🟡|🟢|⚪)\s+\*\*([A-Za-z0-9]+)\*\*\s*\n+/;
```

- [ ] **Step 4: Run tests**

```bash
npm run typecheck && npm test -- src/improve/findings.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/improve/findings.ts src/improve/findings.test.ts
git commit -m "fix(findings): add 🟠 (P1) to BADGE_PATTERN; allow alphanumeric badge labels"
```

---

### Task 5: Skill file updates — P0–P3 definitions + new field guidance

**Files:**
- Modify: `skills/code-reviewer.md`
- Modify: `skills/silent-failure-hunter.md`
- Modify: `skills/pr-test-analyzer.md`
- Modify: `skills/security-sast.md`
- Modify: `skills/code-review-and-quality.md`
- Modify: `skills/type-design-analyzer.md`
- Modify: `skills/comment-analyzer.md`
- Modify: `skills/security-auditor.md`
- Modify: `skills/architect-review.md`

**Interfaces:**
- Consumes: nothing from code
- Produces: agents receive clear P0–P3 definitions, category enum values, evidence/confidence/suppressible guidance, and suggestion discipline rules — so the new schema fields are populated correctly at inference time

- [ ] **Step 1: Draft the standard severity + fields block**

This block goes into every skill file. Add it as a section titled `## Severity, Fields, and Suggestions` — place it before the main review instructions (typically near the top after any existing preamble/YAML front-matter).

```markdown
## Severity, Fields, and Suggestions

### Severity scale (P0–P3)

| Level | Emoji | Meaning | May be suppressible? |
|-------|-------|---------|----------------------|
| P0    | 🔴    | Critical — crash, data loss, auth bypass, RCE | Never |
| P1    | 🟠    | High — correctness bug with real user impact | Rarely |
| P2    | 🟡    | Medium — important but not immediately blocking | Sometimes |
| P3    | 🟢    | Low / nitpick — style, naming, docs | Yes, by default |

**Never mark a P0 finding as `suppressible: true`.** P0 means the code is unsafe to ship.

### Required fields on every finding

- **`category`**: one of `bug`, `security`, `performance`, `test-gap`, `architecture`, `style`, `nitpick`. Pick the dominant concern. A security-relevant bug is `security`.
- **`confidence`**: 0.0–1.0, your self-assessed certainty that the finding is real. Use ≥0.8 for findings you're stating as fact; use 0.5–0.8 for findings that depend on context you can't see. Do not emit a finding with confidence < 0.5 — discard it instead.
- **`evidence`**: the specific code path, line, or observable behavior that supports this finding. Must be non-empty. Example: `"src/auth.ts line 42: req.body.token passed to exec() without sanitization"`. A finding with no evidence is a guess — do not submit guesses.
- **`suppressible`**: `true` if a team could reasonably decide to accept or silence this class of issue (e.g. a naming convention the codebase intentionally ignores). `false` if the finding is a defect every team must address.

### When to emit a `suggestion` (inline comments only)

**Emit a `suggestion` when:**
- The fix fits entirely on the commented line(s) — no new imports, no cross-file changes.
- The change is mechanical: renaming, adding a null check, fixing a literal — not a design decision.
- You are confident the suggested code is correct as written, not a sketch.
- You know the multi-line range (`start_line` to `line`) if the fix spans multiple lines.

**Do NOT emit a `suggestion` when:**
- The fix requires broader context you don't have.
- Multiple valid fixes exist — describe them in `body` instead.
- The fix spans files or requires adding imports.
```

- [ ] **Step 2: Add the block to every skill file**

For each of the 9 skill files, locate where the review instructions begin (after YAML front-matter, if any) and insert the block from Step 1. Preserve any existing framework-specific headings that come after it.

Do each file as a targeted edit — read the current front-matter and first heading, then insert after the first top-level section or after the YAML block.

- [ ] **Step 3: Verify no skill file has been truncated**

```bash
for f in skills/*.md; do
  echo "=== $f ===" && wc -l "$f"
done
```

All files should have MORE lines than before. A shorter file means content was accidentally removed.

- [ ] **Step 4: Commit**

```bash
git add skills/*.md
git commit -m "docs(skills): add P0–P3 severity, required fields, and suggestion discipline to all skill prompts"
```

---

### Task 5 wrap-up: PR 1 quality gates

- [ ] **Step 1: Run full quality gates**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all green. Fix any remaining failures before opening PR 1.

- [ ] **Step 2: Confirm P0 acceptance criterion**

The spec requires "at least one test exercises a P0 finding end-to-end through `mergeReviews()` and `buildReviewComments()`." Find a test that does this or add:

```ts
it("mergeReviews keeps a P0 finding and sets event to REQUEST_CHANGES", () => {
  const reviews = [buildModelReview({
    event: "REQUEST_CHANGES",
    general_findings: [{
      title: "RCE via eval",
      body: "Unsanitized user input passed to eval().",
      severity: "P0",
      category: "security",
      confidence: 0.99,
      evidence: "src/eval.ts:10 — eval(req.body.code)",
      suppressible: false,
    }],
  })];
  const merged = mergeReviews(reviews);
  expect(merged.event).toBe("REQUEST_CHANGES");
  expect(merged.general_findings[0].severity).toBe("P0");
  expect(merged.general_findings[0].suppressible).toBe(false);
});
```

- [ ] **Step 3: Open PR 1**

```bash
git push -u origin feat/phase1-schema-severity
gh pr create --title "feat: Phase 1 — P0–P3 severity scale + schema fields (category, confidence, evidence, suppressible)" \
  --body "$(cat <<'EOF'
## Summary
- Replaces high/medium/low severity with P0–P3 scale (🔴🟠🟡🟢)
- Extends ModelReviewSchema with category, confidence, evidence (required, non-empty), suppressible
- Adds KV migration shim for legacy severity strings (high→P1, medium→P2, low→P3)
- Updates BADGE_PATTERN to recognize 🟠 (P1) and alphanumeric labels
- Adds P0–P3 definitions + required-field + suggestion discipline guidance to all 9 skill files

## Test plan
- [ ] `npm run typecheck` green
- [ ] `npm run lint` green
- [ ] `npm run test` green (all 216+ tests)
- [ ] P0 finding end-to-end test passes
- [ ] KV migration shim tests (4 cases) pass
EOF
)"
```

---

## ── PR 2: Template + Metadata ────────────────────────────────────────────────

> Open this branch off `main` AFTER PR 1 merges. All tasks below assume P0–P3 and the new schema fields are live.

---

### Task 6: `formatFindings()` Category column

**Files:**
- Modify: `src/review.ts` — `formatFindings()`
- Modify: `src/review.test.ts` — snapshot test for the new table shape

**Interfaces:**
- Consumes: `ModelFinding` (now has `.category` from Task 2)
- Produces: `formatFindings()` returns `| Sev | Category | Finding |\n|---|---|---|\n...` for non-empty inputs

- [ ] **Step 1: Write failing snapshot test**

```ts
it("formatFindings renders a three-column table with Category", () => {
  // Call the exported formatFindings (must be exported from review.ts)
  const findings = [
    {
      title: "Unsanitized input",
      body: "Details.",
      severity: "P1" as const,
      category: "security" as const,
      confidence: 0.9,
      evidence: "src/api.ts:5",
      suppressible: false,
    },
    {
      title: "Long variable name",
      body: "Rename it.",
      severity: "P3" as const,
      category: "style" as const,
      confidence: 0.7,
      evidence: "src/utils.ts:10",
      suppressible: true,
    },
  ];
  const result = formatFindings(findings);
  expect(result).toContain("| Sev | Category | Finding |");
  expect(result).toContain("security");
  expect(result).toContain("style");
  expect(result).toMatchInlineSnapshot(`
    "| Sev | Category | Finding |
    |---|---|---|
    | 🟠 | security | **Unsanitized input** |
    | 🟢 | style | **Long variable name** |"
  `);
});
```

`formatFindings` must be exported: add `export` to its declaration in `review.ts`.

- [ ] **Step 2: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/review.test.ts 2>&1 | grep -A5 "three-column table"
```

Expected: FAIL — current table has only two columns (`| Sev | Finding |`), and `formatFindings` is not exported.

- [ ] **Step 3: Update `formatFindings` in `src/review.ts`**

```ts
export function formatFindings(findings: ModelFinding[]): string {
  if (findings.length === 0) return "";

  const rows = findings
    .map(
      (f) =>
        `| ${SEVERITY_EMOJI[f.severity] ?? "⚪"} | ${f.category} | **${f.title}** |`,
    )
    .join("\n");

  return `| Sev | Category | Finding |\n|---|---|---|\n${rows}`;
}
```

- [ ] **Step 4: Run tests**

```bash
npm run typecheck && npm test -- src/review.test.ts
```

Expected: the new snapshot test passes. Fix the inline snapshot if vitest prints an updated value — run once with `--update-snapshots` if needed.

- [ ] **Step 5: Update `priorBlock` in `buildReview()` to match new three-column format**

The `priorBlock` table (lines 1734–1740 in `review.ts`) currently renders a two-column table. It should stay two-column because `PersistedFinding` doesn't have `category`. Leave it as-is — the spec only requires the live findings table to have Category.

- [ ] **Step 6: Commit**

```bash
git add src/review.ts src/review.test.ts
git commit -m "feat: add Category column to general findings table"
```

---

### Task 7: `computeReadinessScore()`

**Files:**
- Modify: `src/review.ts` — add `computeReadinessScore()` (exported), add `renderReadinessBar()`

**Interfaces:**
- Consumes: `finalEvent: ReviewDecision["event"]`, `mergedReview: ModelReview`, `survivingPrior: PersistedFinding[]`, `allAgentsSucceeded: boolean` (from `agentResults.length === allSkills.length`)
- Produces:
  - `computeReadinessScore(opts): number` — deterministic integer 1–5
  - `renderReadinessBar(score: number): string` — e.g. `"🟩🟩🟩⬜⬜ **3/5**"`

- [ ] **Step 1: Write failing unit tests**

```ts
import { computeReadinessScore, renderReadinessBar } from "./review.js";
// (add to the existing review.test.ts imports)

describe("computeReadinessScore", () => {
  const baseOpts = {
    mergedReview: buildModelReview() as any,
    survivingPrior: [],
    allAgentsSucceeded: true,
  };

  it("returns 5 for APPROVE", () => {
    expect(computeReadinessScore({ ...baseOpts, finalEvent: "APPROVE" })).toBe(5);
  });

  it("returns 1 when a P0 general finding exists", () => {
    const mergedReview = buildModelReview({
      event: "REQUEST_CHANGES",
      general_findings: [{ title: "RCE", body: "b", severity: "P0", category: "security", confidence: 0.99, evidence: "e", suppressible: false }],
    }) as any;
    expect(computeReadinessScore({ ...baseOpts, finalEvent: "REQUEST_CHANGES", mergedReview })).toBe(1);
  });

  it("returns 1 when a P0 inline comment exists", () => {
    const mergedReview = buildModelReview({
      event: "REQUEST_CHANGES",
      inline_comments: [buildInlineComment({ severity: "P0", suppressible: false })],
    }) as any;
    expect(computeReadinessScore({ ...baseOpts, finalEvent: "REQUEST_CHANGES", mergedReview })).toBe(1);
  });

  it("returns 2 when survivingPrior is non-empty", () => {
    const prior = [{ id: "1", path: null, line: null, title: "Open", severity: "P1", status: "open" as const }];
    expect(computeReadinessScore({ ...baseOpts, finalEvent: "REQUEST_CHANGES", survivingPrior: prior })).toBe(2);
  });

  it("returns 3 for REQUEST_CHANGES with no P0 and no prior", () => {
    expect(computeReadinessScore({ ...baseOpts, finalEvent: "REQUEST_CHANGES" })).toBe(3);
  });

  it("returns 4 for COMMENT when all agents succeeded", () => {
    expect(computeReadinessScore({ ...baseOpts, finalEvent: "COMMENT" })).toBe(4);
  });

  it("returns 3 for COMMENT when not all agents succeeded", () => {
    expect(computeReadinessScore({ ...baseOpts, finalEvent: "COMMENT", allAgentsSucceeded: false })).toBe(3);
  });
});

describe("renderReadinessBar", () => {
  it("renders 5/5 as five filled squares", () => {
    expect(renderReadinessBar(5)).toBe("🟩🟩🟩🟩🟩 **5/5**");
  });

  it("renders 3/5 correctly", () => {
    expect(renderReadinessBar(3)).toBe("🟩🟩🟩⬜⬜ **3/5**");
  });

  it("renders 1/5 as one filled square", () => {
    expect(renderReadinessBar(1)).toBe("🟩⬜⬜⬜⬜ **1/5**");
  });
});
```

- [ ] **Step 2: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/review.test.ts 2>&1 | grep -A3 "computeReadinessScore"
```

Expected: FAIL — `computeReadinessScore` does not exist.

- [ ] **Step 3: Implement `computeReadinessScore` and `renderReadinessBar` in `src/review.ts`**

Add after the `SEVERITY_LEVELS` block (before `ModelReviewSchema`):

```ts
export function computeReadinessScore(opts: {
  finalEvent: ReviewDecision["event"];
  mergedReview: ModelReview;
  survivingPrior: PersistedFinding[];
  allAgentsSucceeded: boolean; // agentResults.length === allSkills.length from Promise.allSettled()
}): number {
  const { finalEvent, mergedReview, survivingPrior, allAgentsSucceeded } = opts;

  if (finalEvent === "APPROVE") return 5;

  const hasP0 = [
    ...mergedReview.general_findings,
    ...mergedReview.inline_comments,
  ].some((f) => f.severity === "P0");
  if (hasP0) return 1;

  if (survivingPrior.length > 0) return 2;

  if (finalEvent === "REQUEST_CHANGES") return 3;

  // finalEvent === "COMMENT"
  return allAgentsSucceeded ? 4 : 3;
}

export function renderReadinessBar(score: number): string {
  const filled = "🟩".repeat(score);
  const empty = "⬜".repeat(5 - score);
  return `${filled}${empty} **${score}/5**`;
}
```

Note: `ReviewDecision` and `PersistedFinding` are already in scope in `review.ts`. `ModelReview` is also in scope. These functions must be defined AFTER the `ModelReview` type is declared (i.e. after `ModelReviewSchema`), or use a forward reference. Place them after `export type ModelReview = z.infer<typeof ModelReviewSchema>`.

- [ ] **Step 4: Run tests**

```bash
npm run typecheck && npm test -- src/review.test.ts
```

Expected: all 7 readiness score tests + 3 bar render tests green.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/review.test.ts
git commit -m "feat: add computeReadinessScore() and renderReadinessBar()"
```

---

### Task 8: `parseReviewMetadata()` + `ReviewMetaParsed`

**Files:**
- Modify: `src/review.ts` — add `ReviewMetaParsed` interface and `parseReviewMetadata()` (exported)

**Interfaces:**
- Consumes: review body string
- Produces: `parseReviewMetadata(body): ReviewMetaParsed | null` — returns the structured block or `null` for pre-Phase-1 reviews

- [ ] **Step 1: Write failing tests**

```ts
describe("parseReviewMetadata", () => {
  it("returns null for a body with no metadata block", () => {
    expect(parseReviewMetadata("### Claude Review\n\nsome text")).toBeNull();
  });

  it("parses a valid metadata block", () => {
    const body = [
      "<!-- ai-review:sha=abc123def456 -->",
      "<!-- ai-review:review=3 -->",
      "<!-- ai-review:readiness=4 -->",
      "<!-- ai-review:provider=anthropic -->",
      "<!-- ai-review:model=claude-sonnet-5 -->",
      "<!-- ai-review:findings=7 -->",
      "<!-- ai-review:cost=0.000123 -->",
    ].join("\n");
    const result = parseReviewMetadata(body);
    expect(result).toEqual({
      sha: "abc123def456",
      review: 3,
      readiness: 4,
      provider: "anthropic",
      model: "claude-sonnet-5",
      findings: 7,
      cost: 0.000123,
    });
  });

  it("returns null for a malformed metadata block (missing sha)", () => {
    const body = "<!-- ai-review:review=1 -->";
    expect(parseReviewMetadata(body)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/review.test.ts 2>&1 | grep -A3 "parseReviewMetadata"
```

Expected: FAIL — `parseReviewMetadata` does not exist.

- [ ] **Step 3: Implement in `src/review.ts`**

```ts
export interface ReviewMetaParsed {
  sha: string;
  review: number;
  readiness: number;
  provider: string;
  model: string;
  findings: number;
  cost: number;
}

export function parseReviewMetadata(body: string): ReviewMetaParsed | null {
  const extract = (key: string): string | null => {
    const m = body.match(new RegExp(`<!-- ai-review:${key}=([^\\s>]+) -->`));
    return m ? m[1] : null;
  };

  const sha = extract("sha");
  const review = extract("review");
  const readiness = extract("readiness");
  const provider = extract("provider");
  const model = extract("model");
  const findings = extract("findings");
  const cost = extract("cost");

  if (!sha || !review || !readiness || !provider || !model || !findings || !cost) {
    return null;
  }

  return {
    sha,
    review: Number(review),
    readiness: Number(readiness),
    provider,
    model,
    findings: Number(findings),
    cost: Number(cost),
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npm run typecheck && npm test -- src/review.test.ts
```

Expected: all three `parseReviewMetadata` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/review.test.ts
git commit -m "feat: add parseReviewMetadata() and ReviewMetaParsed interface"
```

---

### Task 9: `ReviewState.reviewCount`

**Files:**
- Modify: `src/review-state.ts` — add `reviewCount` to `ReviewState`, increment in `saveReviewState`, default in `loadReviewState`
- Modify: `src/review-state.test.ts` — increment and default tests

**Interfaces:**
- Consumes: existing `ReviewState` shape
- Produces: `ReviewState.reviewCount: number` — starts at 0 for old records, incremented to 1 on first save, then n+1 on each subsequent save

- [ ] **Step 1: Write failing tests**

Add to `src/review-state.test.ts`:

```ts
describe("reviewCount", () => {
  it("defaults reviewCount to 0 for old records that lack it", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({
        lastReviewedSha: "abc",
        event: "COMMENT",
        findings: [],
        reviewedAt: new Date().toISOString(),
        // no reviewCount field
      })),
      set: vi.fn(),
    };
    const state = await loadReviewState(kv as any, "anthropic", "o", "r", 1, null);
    expect(state?.reviewCount).toBe(0);
  });

  it("increments reviewCount from 2 to 3 on save", async () => {
    let stored = "";
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn((key: string, val: string) => { stored = val; }),
    };
    const state = { lastReviewedSha: "abc", event: "COMMENT" as const, findings: [], reviewedAt: "", reviewCount: 2 };
    await saveReviewState(kv as any, "anthropic", "o", "r", 1, state);
    expect(JSON.parse(stored).reviewCount).toBe(3);
  });

  it("increments from 0 to 1 on first save", async () => {
    let stored = "";
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn((key: string, val: string) => { stored = val; }),
    };
    const state = { lastReviewedSha: "abc", event: "COMMENT" as const, findings: [], reviewedAt: "", reviewCount: 0 };
    await saveReviewState(kv as any, "anthropic", "o", "r", 1, state);
    expect(JSON.parse(stored).reviewCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/review-state.test.ts 2>&1 | grep -A3 "reviewCount"
```

Expected: FAIL — `ReviewState` has no `reviewCount`.

- [ ] **Step 3: Update `src/review-state.ts`**

Update `ReviewState`:

```ts
export interface ReviewState {
  lastReviewedSha: string;
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  findings: PersistedFinding[];
  reviewedAt: string;
  reviewCount: number;
}
```

Update `isReviewState` to tolerate missing `reviewCount` (old records):

```ts
function isReviewState(v: unknown): v is ReviewState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.lastReviewedSha === "string" &&
    typeof s.event === "string" &&
    Array.isArray(s.findings)
  );
}
```

In `loadReviewState`, after the shim loop, add:

```ts
// Default reviewCount for records written before Phase 1
if (typeof parsed.reviewCount !== "number") {
  parsed.reviewCount = 0;
}
```

Update `saveReviewState` to increment before writing:

```ts
export async function saveReviewState(
  kv: KvClient,
  provider: string,
  owner: string,
  repo: string,
  pullNumber: number,
  state: ReviewState,
): Promise<void> {
  const toWrite: ReviewState = {
    ...state,
    reviewCount: (state.reviewCount ?? 0) + 1,
  };
  await kv.set(
    stateKey(provider, owner, repo, pullNumber),
    JSON.stringify(toWrite),
    STATE_TTL_SECONDS,
  );
}
```

Update `parsePriorReview` to return `reviewCount: 0` (cold-start from body):

```ts
return {
  lastReviewedSha: shaMatch[1],
  event: findings.length > 0 ? "REQUEST_CHANGES" : "COMMENT",
  findings,
  reviewedAt: new Date().toISOString(),
  reviewCount: 0,
};
```

- [ ] **Step 4: Fix any callers that construct `ReviewState` objects directly**

```bash
npm run typecheck 2>&1 | grep "reviewCount"
```

For any caller that builds a `ReviewState` literal (e.g. in `buildReview()` at line ~1844), add `reviewCount: state?.reviewCount ?? 0` to the object.

- [ ] **Step 5: Run tests**

```bash
npm run typecheck && npm test -- src/review-state.test.ts
```

Expected: all three `reviewCount` tests green.

- [ ] **Step 6: Commit**

```bash
git add src/review-state.ts src/review-state.test.ts
git commit -m "feat(review-state): add reviewCount field; increment on every save, default 0 on old records"
```

---

### Task 10: `formatReviewBody()` pure function

**Files:**
- Modify: `src/review.ts` — add `FormatReviewBodyOptions` interface and `formatReviewBody()` (exported)

**Interfaces:**
- Consumes: all fields currently assembled inline in `buildReview()` (see spec `FormatReviewBodyOptions`)
- Produces: `formatReviewBody(opts): string` — deterministic body string with fixed section order, readiness bar, command hints, and hidden metadata block

- [ ] **Step 1: Write failing unit tests**

```ts
describe("formatReviewBody", () => {
  const baseOpts = {
    commentPrefix: "Claude Review",
    finalEvent: "REQUEST_CHANGES" as const,
    summary: "Two issues found.",
    approvalMessage: "",
    readiness: 3,
    tier2Matches: [],
    skipped: [],
    errored: [],
    allSkillsCount: 5,
    generalFindings: [],
    reviewComments: [],
    dropped: [],
    overflowCount: 0,
    maxInlineComments: 50,
    feedbackEnabled: false,
    survivingPrior: [],
    incrementalPass: false,
    priorSha: "",
    headSha: "abc123def456",
    reviewCount: 2,
    model: "claude-sonnet-5",
    cost: 0.000042,
  };

  it("starts with the commentPrefix heading", () => {
    const body = formatReviewBody(baseOpts);
    expect(body.startsWith("### Claude Review")).toBe(true);
  });

  it("includes the readiness bar", () => {
    const body = formatReviewBody(baseOpts);
    expect(body).toContain("🟩🟩🟩⬜⬜ **3/5**");
  });

  it("includes command hints", () => {
    const body = formatReviewBody(baseOpts);
    expect(body).toContain("/ai-review");
    expect(body).toContain("/ai-review --full");
  });

  it("includes hidden metadata block with sha and reviewCount", () => {
    const body = formatReviewBody(baseOpts);
    expect(body).toContain("<!-- ai-review:sha=abc123def456 -->");
    expect(body).toContain("<!-- ai-review:review=2 -->");
    expect(body).toContain("<!-- ai-review:readiness=3 -->");
  });

  it("roundtrips through parseReviewMetadata", () => {
    const body = formatReviewBody(baseOpts);
    const meta = parseReviewMetadata(body);
    expect(meta?.sha).toBe("abc123def456");
    expect(meta?.review).toBe(2);
    expect(meta?.readiness).toBe(3);
    expect(meta?.model).toBe("claude-sonnet-5");
  });

  it("shows approvalMessage instead of summary on APPROVE", () => {
    const body = formatReviewBody({
      ...baseOpts,
      finalEvent: "APPROVE",
      approvalMessage: "✅ No issues found. PR approved for merge.",
      readiness: 5,
    });
    expect(body).toContain("✅ No issues found.");
    expect(body).not.toContain("Two issues found.");
  });

  it("includes partial review notice when agents were skipped", () => {
    const body = formatReviewBody({ ...baseOpts, skipped: ["security-sast.md"] });
    expect(body).toContain("Partial review");
    expect(body).toContain("security-sast");
  });
});
```

- [ ] **Step 2: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/review.test.ts 2>&1 | grep -A3 "formatReviewBody"
```

Expected: FAIL — `formatReviewBody` does not exist.

- [ ] **Step 3: Implement `FormatReviewBodyOptions` and `formatReviewBody` in `src/review.ts`**

Add after the `renderReadinessBar` function:

```ts
export interface FormatReviewBodyOptions {
  commentPrefix: string;
  finalEvent: ReviewDecision["event"];
  summary: string;
  approvalMessage: string;
  readiness: number;
  tier2Matches: { skillPath: string; reason: string }[];
  skipped: string[];
  errored: string[];
  allSkillsCount: number;
  generalFindings: ModelFinding[];
  reviewComments: ReviewComment[];
  dropped: ModelInlineComment[];
  overflowCount: number;
  maxInlineComments: number;
  feedbackEnabled: boolean;
  survivingPrior: PersistedFinding[];
  incrementalPass: boolean;
  priorSha: string;
  headSha: string;
  reviewCount: number;
  model: string;
  cost: number;
}

export function formatReviewBody(opts: FormatReviewBodyOptions): string {
  const {
    commentPrefix, finalEvent, summary, approvalMessage, readiness,
    tier2Matches, skipped, errored, allSkillsCount, generalFindings,
    reviewComments, dropped, overflowCount, maxInlineComments,
    feedbackEnabled, survivingPrior, incrementalPass, priorSha,
    headSha, reviewCount, model, cost,
  } = opts;

  const readinessBar = renderReadinessBar(readiness);

  const tier2Notice = tier2Matches.length > 0
    ? `#### Additional skills activated\n\n${tier2Matches
        .map(({ skillPath, reason }) => `- \`${skillPath.replace(/\.md$/, "")}\` — ${reason}`)
        .join("\n")}`
    : "";

  const budgetNotices: string[] = [];
  if (skipped.length > 0) {
    budgetNotices.push(
      `> ⏱ **Partial review.** ${skipped.length} of ${allSkillsCount} agents did not run — this pass hit its time budget before reaching ${skipped.map((s) => `\`${s.replace(/\.md$/, "")}\``).join(", ")}. Re-run the review command for full coverage.`,
    );
  }
  if (errored.length > 0) {
    budgetNotices.push(
      `> ⚠️ **Partial review.** ${errored.length} of ${allSkillsCount} agent(s) failed to complete: ${errored.map((s) => `\`${s.replace(/\.md$/, "")}\``).join(", ")}. Re-run the review command for full coverage.`,
    );
  }

  const findingsBlock = formatFindings(generalFindings);

  const inlineSummary = reviewComments.length > 0
    ? `Inline comments: ${reviewComments.length}`
    : "Inline comments: none";

  const priorBlockExplanation = incrementalPass
    ? `This pass reviewed only what changed since \`${priorSha.slice(0, 12)}\`, so these were not re-checked.`
    : "These were flagged in a previous review; the agents were instructed not to restate them, so they are carried forward as still open.";
  const priorBlock = survivingPrior.length > 0
    ? `#### Still open from the previous review\n\n${priorBlockExplanation}\n\n| Sev | Finding |\n|---|---|\n${survivingPrior
        .map((f) => {
          const where = f.path && f.line != null ? ` (\`${f.path}:${f.line}\`)` : "";
          return `| ${SEVERITY_EMOJI[f.severity as Severity] ?? UNKNOWN_SEVERITY_BADGE} | **${f.title}**${where} |`;
        })
        .join("\n")}`
    : "";

  const droppedNotice = dropped.length > 0
    ? `> ⚠️ ${dropped.length} inline comment${dropped.length === 1 ? "" : "s"} could not be anchored to the diff and ${dropped.length === 1 ? "was" : "were"} posted here instead:\n${dropped
        .map((c) => `> - ${SEVERITY_EMOJI[c.severity as Severity] ?? UNKNOWN_SEVERITY_BADGE} **${c.title}** (\`${c.path}:${c.line}\`)`)
        .join("\n")}`
    : "";

  const overflowNotice = overflowCount > 0
    ? `> ℹ️ ${overflowCount} inline comment${overflowCount === 1 ? "" : "s"} not posted (${maxInlineComments}-comment cap; lowest-severity findings dropped first). Re-run with \`/ai-review\` on a smaller diff for complete coverage.`
    : "";

  const feedbackInvite = feedbackEnabled && reviewComments.length > 0
    ? "💬 React on any inline comment to train our reviewers: 👍 it helped, 👎 it was wrong, 😕 it didn't land. For 😕, please also reply saying why — the reply is what we learn from."
    : "";

  const commandHints =
    "> Re-run: `/ai-review` · Full diff: `/ai-review --full` · Skip: `/ai-review --skip`";

  const metadataBlock = [
    `<!-- ai-review:sha=${headSha} -->`,
    `<!-- ai-review:review=${reviewCount} -->`,
    `<!-- ai-review:readiness=${readiness} -->`,
    `<!-- ai-review:provider=${model.includes("gpt") || model.includes("o4") ? "openai" : "anthropic"} -->`,
    `<!-- ai-review:model=${model} -->`,
    `<!-- ai-review:findings=${generalFindings.length} -->`,
    `<!-- ai-review:cost=${cost.toFixed(6)} -->`,
  ].join("\n");

  const costFooter = `---\n*Model: ${model} · ${allSkillsCount} agents · $${cost.toFixed(6)} · [ai-review-bot](https://github.com/joeblackwaslike/ai-review-bot)*`;

  const parts = [
    `### ${commentPrefix}`,
    readinessBar,
    finalEvent === "APPROVE" ? approvalMessage : summary,
    tier2Notice,
    ...budgetNotices,
    ...(finalEvent === "APPROVE" ? [] : [inlineSummary]),
    droppedNotice,
    overflowNotice,
    feedbackInvite,
    findingsBlock,
    priorBlock,
    commandHints,
    metadataBlock,
    costFooter,
  ];

  return parts
    .filter((part) => part.length > 0)
    .join("\n\n");
}
```

Note: The `provider` derivation in `metadataBlock` is a heuristic based on model name. If a cleaner approach is preferred, add `provider: string` to `FormatReviewBodyOptions` and pass it explicitly — but this avoids adding a field to the already-large options bag.

- [ ] **Step 4: Run tests**

```bash
npm run typecheck && npm test -- src/review.test.ts
```

Expected: all 7 `formatReviewBody` tests green (including the roundtrip test with `parseReviewMetadata`).

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/review.test.ts
git commit -m "feat: add formatReviewBody() pure function with readiness bar, command hints, and metadata block"
```

---

### Task 11: Wire into `buildReview()`, update SHA probe, update `report.ts`

**Files:**
- Modify: `src/review.ts` — replace inline body assembly with `formatReviewBody()`; switch SHA probe to `parseReviewMetadata()`
- Modify: `src/review-state.ts` — pass `reviewCount` in `newState`
- Modify: `src/report.ts` — add `readiness` to front-matter (optional for PR 2)

**Interfaces:**
- Consumes: `formatReviewBody()` from Task 10, `computeReadinessScore()` from Task 7, `parseReviewMetadata()` from Task 8, `ReviewState.reviewCount` from Task 9
- Produces: `buildReview()` now returns a body built by `formatReviewBody()` exclusively. SHA idempotency check uses `parseReviewMetadata()`.

- [ ] **Step 1: Write integration test for the new body format**

In `src/review.test.ts`, find the test that exercises `buildReview()` end-to-end (the mock-based tests). Add an assertion:

```ts
it("buildReview body includes the metadata block with sha and readiness", async () => {
  // (Use the existing mock setup for buildReview — locate it in the file)
  // After calling buildReview(...), assert on the returned body:
  const decision = await buildReview(ctx);
  expect(decision?.body).toContain("<!-- ai-review:sha=");
  expect(decision?.body).toContain("<!-- ai-review:readiness=");
  expect(decision?.body).toContain("> Re-run: `/ai-review`");
  // SHA probe uses parseReviewMetadata, not body.includes:
  expect(decision?.body).not.toContain("Reviewed commit: `");
});
```

- [ ] **Step 2: Run to confirm RED**

```bash
npm test -- --reporter=verbose src/review.test.ts 2>&1 | grep -A3 "metadata block with sha"
```

Expected: FAIL — the body still uses the old `reviewMarker` format.

- [ ] **Step 3: Replace body assembly in `buildReview()`**

In `src/review.ts`, find the `buildReview()` body assembly (the `const body = [...]` block around line 1774). Replace the entire block with:

```ts
const readiness = computeReadinessScore({
  finalEvent,
  mergedReview: modelReview,
  survivingPrior,
  allAgentsSucceeded,
});

const body = formatReviewBody({
  commentPrefix: context.commentPrefix,
  finalEvent,
  summary,
  approvalMessage,
  readiness,
  tier2Matches,
  skipped,
  errored,
  allSkillsCount: allSkills.length,
  generalFindings: modelReview.general_findings,
  reviewComments,
  dropped,
  overflowCount: overflowComments.length,
  maxInlineComments: MAX_INLINE_COMMENTS,
  feedbackEnabled: context.feedbackEnabled,
  survivingPrior,
  incrementalPass,
  priorSha,
  headSha: context.headSha,
  reviewCount: state?.reviewCount ?? 0,
  model: selection.model,
  cost,
});
```

Remove the old `reviewMarker`, `findingsBlock`, `inlineSummary`, `feedbackInvite`, `budgetNotice`, `tier2Notice`, `priorBlock`, `droppedNotice`, `overflowNotice`, and `costFooter` declarations (they are now inside `formatReviewBody`).

- [ ] **Step 4: Switch SHA probe to `parseReviewMetadata()`**

In `buildReview()`, find the idempotency check (~line 1029):

```ts
// OLD:
const alreadyReviewed = existingReviews.some((review) => {
  const body = review.body ?? "";
  return (
    body.includes(reviewMarker) &&
    body.includes(`### ${context.commentPrefix}`)
  );
});

// NEW:
const alreadyReviewed = existingReviews.some((review) => {
  const body = review.body ?? "";
  if (!body.includes(`### ${context.commentPrefix}`)) return false;
  return parseReviewMetadata(body)?.sha === context.headSha;
});
```

Also update the `priorBotReviews` filter (~line 1047) that uses `body.includes("Reviewed commit: \`")`:

```ts
// OLD:
if (body.includes("Reviewed commit: `")) {
  return body.includes(reviewMarker);
}

// NEW:
if (body.includes("<!-- ai-review:sha=")) {
  return parseReviewMetadata(body)?.sha === context.headSha;
}
// Fallback for pre-Phase-1 reviews in priorBotReviews filter:
if (body.includes("Reviewed commit: `")) {
  return body.includes(`Reviewed commit: \`${context.headSha.slice(0, 12)}\``);
}
```

And `priorOwnReview` filter (~line 1059):

```ts
// OLD:
body.includes("Reviewed commit: `") &&
!body.includes(reviewMarker)

// NEW:
(body.includes("<!-- ai-review:sha=") || body.includes("Reviewed commit: `")) &&
parseReviewMetadata(body)?.sha !== context.headSha &&
!body.includes(`Reviewed commit: \`${context.headSha.slice(0, 12)}\``)
```

Remove the `const reviewMarker = ...` declaration at the top of `buildReview()` — it is no longer needed.

- [ ] **Step 5: Pass `reviewCount` into `newState` in `buildReview()`**

Find the `newState` construction (~line 1844):

```ts
const newState: ReviewState = {
  lastReviewedSha: context.headSha,
  event: persistedEvent,
  findings: persistedFindings,
  reviewedAt: new Date().toISOString(),
  reviewCount: state?.reviewCount ?? 0,  // saveReviewState will increment this to n+1
};
```

- [ ] **Step 6: Run full quality gates**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all green. Fix any typecheck or test failures before proceeding.

- [ ] **Step 7: Commit**

```bash
git add src/review.ts src/review-state.ts
git commit -m "feat: wire formatReviewBody() into buildReview(); switch SHA probe to parseReviewMetadata()"
```

---

### Task 11 wrap-up: PR 2 quality gates + open PR

- [ ] **Step 1: Verify `formatReviewBody()` acceptance criteria**

Run the complete test suite and confirm:

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tail -20
```

Verify the following acceptance criteria from the spec:

1. `formatReviewBody()` has unit tests covering: APPROVE, REQUEST_CHANGES no prior, REQUEST_CHANGES with surviving prior, partial review (skipped agents), P0 present → readiness 1
2. `computeReadinessScore()` covers all 6 rows of the scoring table
3. `parseReviewMetadata()` roundtrips through `formatReviewBody()`
4. `buildReview()` uses `formatReviewBody()` exclusively — grep to confirm no `const body = [` array assembly remains:

```bash
grep -n "const body = \[" src/review.ts
```

Expected: zero results.

5. SHA idempotency check uses `parseReviewMetadata()`:

```bash
grep -n "body.includes.*Reviewed commit" src/review.ts
```

Expected: only in the `priorBotReviews`/`priorOwnReview` fallback, not in the idempotency check.

6. `ReviewState.reviewCount` increments correctly — covered by Task 9 tests.

- [ ] **Step 2: Open PR 2**

```bash
git push -u origin feat/phase1-template-metadata
gh pr create --title "feat: Phase 1 — deterministic formatReviewBody(), readiness score, metadata block" \
  --body "$(cat <<'EOF'
## Summary
- Extracts body assembly into pure `formatReviewBody()` with fixed section order
- Adds readiness score (1–5, filled squares) and `renderReadinessBar()`
- Adds `computeReadinessScore()` driven by P0 presence, surviving prior, event, agent success
- Adds `parseReviewMetadata()` and hidden `<!-- ai-review:key=value -->` metadata block
- Adds command hints blockquote (`/ai-review`, `/ai-review --full`, `/ai-review --skip`)
- Adds Category column to general findings table
- `ReviewState.reviewCount` increments on every save; SHA idempotency uses `parseReviewMetadata()`

## Depends on
PR 1 (feat/phase1-schema-severity) must be merged first.

## Test plan
- [ ] `npm run typecheck` green
- [ ] `npm run lint` green
- [ ] `npm run test` green
- [ ] `formatReviewBody()` roundtrip test (sha, readiness, review count) passes
- [ ] `computeReadinessScore()` 6-row coverage passes
- [ ] `parseReviewMetadata()` null and roundtrip tests pass
- [ ] No `const body = [` array assembly in `buildReview()`
EOF
)"
```

---

## Self-Review Checklist

**Spec coverage scan:**

| Spec section | Task(s) covering it |
|---|---|
| Finding Schema v2 — category, confidence, evidence, suppressible | Task 2 |
| Severity scale P0–P3 + emoji map | Task 1 |
| Breaking changes: SEVERITY_LEVELS, rank maps, report.ts | Task 1 |
| KV migration shim | Task 3 |
| parseFindingComment 🟠 + BADGE_TO_SEVERITY | Task 4 |
| Skill file P0–P3 + field guidance + suggestion discipline | Task 5 |
| Deterministic formatReviewBody() | Task 10, 11 |
| Fixed section order in body | Task 10 |
| formatFindings() Category column | Task 6 |
| computeReadinessScore() | Task 7 |
| renderReadinessBar() | Task 7 |
| parseReviewMetadata() + ReviewMetaParsed | Task 8 |
| ReviewState.reviewCount | Task 9 |
| Hidden metadata block | Task 10 |
| Command hints | Task 10 |
| SHA probe → parseReviewMetadata() | Task 11 |
| Pre-Phase-1 review migration (null → re-review) | Task 11, Step 4 |

**Gaps found:** None — all spec deliverables are covered.

**Type consistency check:**
- `Severity` is `"P0" | "P1" | "P2" | "P3"` throughout (defined in Task 1, used by all tasks)
- `Category` is defined in `review.ts` and imported in `testing.ts` (Task 2, Step 5)
- `formatReviewBody(opts: FormatReviewBodyOptions)` — the type is defined alongside the function in `review.ts` (Task 10, Step 3), and `buildReview()` passes values from its own locals without renaming (Task 11, Step 3)
- `computeReadinessScore()` takes `PersistedFinding[]` for `survivingPrior` — consistent with `review-state.ts` type (Task 7)
- `ReviewState.reviewCount` is `number` in the interface and defaults to `0` in both `loadReviewState` and `parsePriorReview` (Task 9)
