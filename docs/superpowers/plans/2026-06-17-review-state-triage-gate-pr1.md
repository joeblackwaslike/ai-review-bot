# Review-State + Triage Gate (PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the review bot resolution-aware and incremental: persist per-bot review state, gate re-reviews behind a cheap triage call (SKIP / INCREMENTAL / FULL), drop resolved findings so a correct PR can reach APPROVE, and temporarily cap to Tier 1 agents to stay under the 800s budget until PR2 lands.

**Architecture:** A new `review-state` module persists findings + last-reviewed SHA in Upstash KV (with a GitHub re-parse fallback). A new `triage` module fetches the delta since the bot's last review and asks a cheap model whether to SKIP/INCREMENTAL/FULL. `buildReview` consults them before the expensive agent fan-out. `mergeReviews` and the agent prompt become prior-finding-aware so already-addressed findings stop blocking.

**Tech Stack:** TypeScript ESM, Vitest, Vercel AI SDK (`generateObject`), Upstash KV, Octokit. Named exports only; `.js` import extensions; Biome lint/format.

**Spec:** `docs/superpowers/specs/2026-06-17-review-state-aware-incremental-review-design.md`
**Branch:** `feat/review-state-triage-gate` (already created; spec already committed)
**Epic bead:** `ai-review-bot-9nv`

---

## File Structure

- **Create `src/review-state.ts`** — `ReviewState` / `PersistedFinding` types; `loadReviewState()` (KV → GitHub re-parse → null), `saveReviewState()`, `findingId()`, `stateKey()`. One responsibility: persistence + identity of review state.
- **Create `src/review-state.test.ts`** — round-trip, TTL, cold fallback.
- **Create `src/triage.ts`** — `fetchDelta()` (compare API), `triageReReview()` (cheap `generateObject` call), `TriageDecision` type + Zod schema, fail-safe fallback. One responsibility: the re-review decision.
- **Create `src/triage.test.ts`** — decode SKIP/INCREMENTAL/FULL, resolved-id mapping, error→review.
- **Modify `src/config.ts`** — add `REVIEW_TIER2_ENABLED` (default OFF in PR1).
- **Modify `src/config.test.ts`** — tier2 flag tests.
- **Modify `src/prompt.ts`** — inject `priorOwnReview` + resolved findings into `buildUserMessage`; raise `trimPatch` cap.
- **Modify `src/prompt.test.ts`** — prior-review section present; cap respected.
- **Modify `src/review.ts`** — prior-finding-aware `mergeReviews`; Tier 2 gate; wire triage gate into `buildReview`; persist state; SKIP check-run re-stamp.
- **Modify `src/review.test.ts`** — merge drops-resolved/event-clears; triage gate paths; multi-bot scenario.

---

## Task 1: `REVIEW_TIER2_ENABLED` config flag (Tier 2 interlock)

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/config.test.ts` (inside the existing top-level `describe` area, after the delay block). Also add `"REVIEW_TIER2_ENABLED"` to the `afterEach` cleanup array.

```typescript
describe("tier2Enabled", () => {
	it("defaults to false in PR1 (Tier 2 disabled until QStash lands)", () => {
		setRequiredEnv();
		delete process.env.REVIEW_TIER2_ENABLED;
		expect(getConfig().tier2Enabled).toBe(false);
	});

	it("is true only when REVIEW_TIER2_ENABLED=true", () => {
		setRequiredEnv({ REVIEW_TIER2_ENABLED: "true" });
		expect(getConfig().tier2Enabled).toBe(true);
		setRequiredEnv({ REVIEW_TIER2_ENABLED: "1" });
		expect(getConfig().tier2Enabled).toBe(false); // only exact "true"
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.test.ts --pool=forks --reporter=basic`
Expected: FAIL — `tier2Enabled` does not exist on `AppConfig`.

- [ ] **Step 3: Implement**

In `src/config.ts`, add to `interface AppConfig` (after `agentConcurrency: number;`):

```typescript
	tier2Enabled: boolean;
```

In BOTH `getConfig()` and `getOpenAIAppConfig()` return objects, add:

```typescript
		tier2Enabled: process.env.REVIEW_TIER2_ENABLED === "true",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config.test.ts --pool=forks --reporter=basic`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): add REVIEW_TIER2_ENABLED flag (default off for PR1)"
```

---

## Task 2: Gate Tier 2 detection behind the flag

**Files:**
- Modify: `src/review.ts` (around the `detectTier2Skills` call, ~line 706, and the `ReviewContext` interface ~line 28)
- Test: `src/review.test.ts`

`ReviewContext` is built in `buildReview` from config. Add a `tier2Enabled` field so the gate is testable and threaded from config.

- [ ] **Step 1: Write the failing test**

Add to `src/review.test.ts`. The file mocks `./prompt.js`; follow its existing `buildReview` test setup (reuse the nearest existing `buildReview` test's context factory). Assert that with `tier2Enabled: false`, `detectTier2Skills` results are not added — i.e. `metadata.tier2Skills` is empty even for a PR that would otherwise trigger Tier 2.

```typescript
it("runs only Tier 1 agents when tier2Enabled is false", async () => {
	// Arrange a PR that WOULD trigger a Tier 2 skill (e.g. a .ts file with type defs)
	const decision = await buildReview(makeCtx({ tier2Enabled: false /* + a tier2-triggering file fixture */ }));
	expect(decision?.metadata.tier2Skills).toEqual([]);
});
```

> Implementation note for the worker: `makeCtx` here stands for the existing helper/pattern the nearest `buildReview` test uses to assemble a `ReviewContext` + mocked octokit. Reuse it; do not invent a new one. If the nearest test inlines the context, inline it the same way and pass `tier2Enabled`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/review.test.ts --pool=forks --reporter=basic`
Expected: FAIL — `tier2Enabled` not on `ReviewContext`, or Tier 2 skills still present.

- [ ] **Step 3: Implement**

In `src/review.ts`:

Add to `interface ReviewContext` (after `agentConcurrency: number;`):

```typescript
	tier2Enabled: boolean;
```

Replace the Tier 2 detection block (currently `const tier2Matches = detectTier2Skills({ ... });`) with:

```typescript
	const tier2Matches = context.tier2Enabled
		? detectTier2Skills({
				filePaths: filePaths,
				additions: context.additions,
				deletions: context.deletions,
				title: context.title,
				body: context.body,
				labels: context.labels,
				patchContent: files.map((f) => f.patch ?? "").join("\n"),
			})
		: [];
```

Find where `buildReview`'s caller constructs `ReviewContext` (in `src/github-app.ts`, inside `maybeSubmitReview`) and pass `tier2Enabled: config.tier2Enabled`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/review.test.ts --pool=forks --reporter=basic`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/review.ts src/review.test.ts src/github-app.ts
git commit -m "feat(review): gate Tier 2 detection behind tier2Enabled"
```

---

## Task 3: Prior-finding-aware merge (drop resolved, relax `.some()`)

**Files:**
- Modify: `src/review.ts` (`mergeReviews`, ~line 313)
- Test: `src/review.test.ts`

Give `mergeReviews` an optional set of resolved finding keys (`path:line` + lowercased title) so already-addressed findings are dropped and a lone re-raise can't force `REQUEST_CHANGES`.

- [ ] **Step 1: Write the failing test**

```typescript
import { mergeReviews } from "./review.js";

describe("mergeReviews resolved handling", () => {
	const reqChanges = {
		event: "REQUEST_CHANGES" as const,
		general_findings: [{ title: "Unvalidated input", body: "x" }],
		inline_comments: [{ path: "src/a.ts", line: 5, body: "fix" }],
	};

	it("drops a resolved finding and clears the event when nothing unresolved remains", () => {
		const resolved = new Set(["general:unvalidated input"]);
		const merged = mergeReviews([reqChanges], resolved);
		expect(merged.general_findings).toHaveLength(0);
		expect(merged.event).toBe("COMMENT");
	});

	it("keeps REQUEST_CHANGES when an unresolved finding remains", () => {
		const merged = mergeReviews([reqChanges], new Set());
		expect(merged.event).toBe("REQUEST_CHANGES");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/review.test.ts -t "mergeReviews resolved" --pool=forks --reporter=basic`
Expected: FAIL — `mergeReviews` takes one arg.

- [ ] **Step 3: Implement**

Change the `mergeReviews` signature and body in `src/review.ts`:

```typescript
export function mergeReviews(
	agentResults: ModelReview[],
	resolved: Set<string> = new Set(),
): ModelReview {
	const isResolvedGeneral = (title: string) =>
		resolved.has(`general:${title.toLowerCase().trim()}`);
	const isResolvedInline = (path: string, line: number) =>
		resolved.has(`inline:${path}:${line}`);

	const seenTitles = new Set<string>();
	const general_findings = agentResults
		.flatMap((r) => r.general_findings)
		.filter((f) => {
			if (isResolvedGeneral(f.title)) return false;
			const key = f.title.toLowerCase().trim();
			if (seenTitles.has(key)) return false;
			seenTitles.add(key);
			return true;
		});

	const commentMap = new Map<
		string,
		{ comment: ModelInlineComment; priority: number }
	>();
	for (const review of agentResults) {
		const priority = review.event === "REQUEST_CHANGES" ? 1 : 0;
		for (const comment of review.inline_comments) {
			if (isResolvedInline(comment.path, comment.line)) continue;
			const key = `${comment.path}:${comment.line}`;
			const existing = commentMap.get(key);
			if (!existing || priority > existing.priority) {
				commentMap.set(key, { comment, priority });
			}
		}
	}

	const inline_comments = Array.from(commentMap.values()).map((v) => v.comment);

	// Event is REQUEST_CHANGES only if an UNRESOLVED finding survived the filters
	// above — a lone re-raise of an already-addressed finding no longer blocks.
	const event: "COMMENT" | "REQUEST_CHANGES" =
		general_findings.length > 0 || inline_comments.length > 0
			? agentResults.some((r) => r.event === "REQUEST_CHANGES")
				? "REQUEST_CHANGES"
				: "COMMENT"
			: "COMMENT";

	return { event, general_findings, inline_comments };
}
```

> Note: the existing single-arg callers still compile (default `resolved = new Set()`), preserving current behavior on the FULL path.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/review.test.ts --pool=forks --reporter=basic`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/review.test.ts
git commit -m "feat(review): mergeReviews drops resolved findings, relaxes event gate"
```

---

## Task 4: Prior-review context in the agent prompt + larger patch cap

**Files:**
- Modify: `src/prompt.ts` (`PromptContext`, `buildUserMessage` ~line 54, `trimPatch` ~line 34)
- Test: `src/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { buildUserMessage } from "./prompt.js";

describe("buildUserMessage prior own review", () => {
	const base = {
		owner: "o", repo: "r", pullNumber: 1, headSha: "abc",
		title: "t", body: null, additions: 1, deletions: 0,
		changedFiles: 1, labels: [], extraInstructions: "",
		files: [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n+x" }],
	};

	it("injects the bot's own prior findings with do-not-re-report guidance", () => {
		const msg = buildUserMessage({
			...base,
			priorOwnReview: "### ai-review\nPrior finding: Unvalidated input",
		});
		expect(msg).toContain("previously raised");
		expect(msg).toContain("Unvalidated input");
	});

	it("omits the prior-review section when none is provided", () => {
		const msg = buildUserMessage(base);
		expect(msg).not.toContain("previously raised");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/prompt.test.ts --pool=forks --reporter=basic`
Expected: FAIL — `priorOwnReview` not part of `PromptContext`, section absent.

- [ ] **Step 3: Implement**

In `src/prompt.ts`, add `priorOwnReview?: string | null;` to `interface PromptContext`.

Add a section builder in `buildUserMessage`, after `priorReviewsSection`:

```typescript
	const priorOwnReviewSection = context.priorOwnReview
		? [
				"",
				"You (this same reviewer) previously raised the findings below. Do NOT re-report a finding if the current diff or a maintainer reply already addresses or justifies it; only escalate if it is still genuinely unresolved in the code under review:",
				"",
				context.priorOwnReview,
			]
		: [];
```

Insert `...priorOwnReviewSection,` into the returned array immediately after `...priorReviewsSection,`.

Raise the patch cap: change `function trimPatch(patch: string, maxChars = 8000)` to `maxChars = 24000`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/prompt.test.ts --pool=forks --reporter=basic`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts src/prompt.test.ts
git commit -m "feat(prompt): inject prior own-review into agent prompt; raise patch cap to 24k"
```

---

## Task 5: `review-state` module (KV persistence + GitHub fallback)

**Files:**
- Create: `src/review-state.ts`
- Test: `src/review-state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { findingId, loadReviewState, saveReviewState, stateKey } from "./review-state.js";

function fakeKv() {
	const store = new Map<string, string>();
	return {
		store,
		client: {
			get: async (k: string) => store.get(k) ?? null,
			set: async (k: string, v: string) => void store.set(k, v),
			setNx: async () => true,
			del: async (...ks: string[]) => { for (const k of ks) store.delete(k); },
		},
	};
}

describe("review-state", () => {
	it("builds a stable per-bot key", () => {
		expect(stateKey("anthropic", "o", "r", 7)).toBe("review-state:anthropic:o/r#7");
	});

	it("round-trips state through KV", async () => {
		const { client } = fakeKv();
		const state = {
			lastReviewedSha: "abc",
			event: "REQUEST_CHANGES" as const,
			findings: [{ id: findingId("src/a.ts", 5, "Bug"), path: "src/a.ts", line: 5, title: "Bug", severity: "high", status: "open" as const }],
			reviewedAt: "2026-06-17T00:00:00Z",
		};
		await saveReviewState(client, "anthropic", "o", "r", 7, state);
		expect(await loadReviewState(client, "anthropic", "o", "r", 7, null)).toEqual(state);
	});

	it("returns null when KV is cold and no prior review is given", async () => {
		const { client } = fakeKv();
		expect(await loadReviewState(client, "anthropic", "o", "r", 7, null)).toBeNull();
	});

	it("falls back to a parsed prior GitHub review when KV is cold", async () => {
		const { client } = fakeKv();
		const prior = "### ai-review\nReviewed commit: `deadbee`\n\n| Sev | Finding |\n|---|---|\n| 🔴 | Unsafe eval |";
		const state = await loadReviewState(client, "anthropic", "o", "r", 7, prior);
		expect(state?.lastReviewedSha).toBe("deadbee");
		expect(state?.findings.some((f) => f.title.includes("Unsafe eval"))).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/review-state.test.ts --pool=forks --reporter=basic`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/review-state.ts`:

```typescript
import type { KvClient } from "./feedback/kv.js";

export type FindingStatus = "open" | "resolved";

export interface PersistedFinding {
	id: string;
	path: string | null;
	line: number | null;
	title: string;
	severity: string;
	status: FindingStatus;
}

export interface ReviewState {
	lastReviewedSha: string;
	event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
	findings: PersistedFinding[];
	reviewedAt: string;
}

const STATE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days, refreshed on each write

export function stateKey(
	provider: string,
	owner: string,
	repo: string,
	pullNumber: number,
): string {
	return `review-state:${provider}:${owner}/${repo}#${pullNumber}`;
}

export function findingId(
	path: string | null,
	line: number | null,
	title: string,
): string {
	return `${path ?? "-"}:${line ?? "-"}:${title.toLowerCase().trim()}`;
}

export async function saveReviewState(
	kv: KvClient,
	provider: string,
	owner: string,
	repo: string,
	pullNumber: number,
	state: ReviewState,
): Promise<void> {
	await kv.set(
		stateKey(provider, owner, repo, pullNumber),
		JSON.stringify(state),
		STATE_TTL_SECONDS,
	);
}

// Best-effort parse of a prior posted review body into findings. The body format
// is the markdown table produced by generateSummary; we only need titles +
// severity for triage, so a loose parse is acceptable.
function parsePriorReview(body: string): ReviewState | null {
	const shaMatch = body.match(/Reviewed commit: `([0-9a-f]{7,40})`/);
	if (!shaMatch) return null;
	const findings: PersistedFinding[] = [];
	for (const line of body.split("\n")) {
		const row = line.match(/^\|\s*([🔴🟡🟢])\s*\|\s*(.+?)\s*\|$/);
		if (!row) continue;
		const severity =
			row[1] === "🔴" ? "high" : row[1] === "🟡" ? "medium" : "low";
		const title = row[2].replace(/\*\*/g, "").trim();
		if (!title || title.toLowerCase() === "finding") continue;
		findings.push({
			id: findingId(null, null, title),
			path: null,
			line: null,
			title,
			severity,
			status: "open",
		});
	}
	return {
		lastReviewedSha: shaMatch[1],
		event: findings.length > 0 ? "REQUEST_CHANGES" : "COMMENT",
		findings,
		reviewedAt: new Date().toISOString(),
	};
}

export async function loadReviewState(
	kv: KvClient,
	provider: string,
	owner: string,
	repo: string,
	pullNumber: number,
	priorOwnReview: string | null,
): Promise<ReviewState | null> {
	const raw = await kv.get(stateKey(provider, owner, repo, pullNumber));
	if (raw) {
		try {
			return JSON.parse(raw) as ReviewState;
		} catch {
			// Corrupt entry — fall through to the GitHub re-parse fallback.
		}
	}
	if (priorOwnReview) return parsePriorReview(priorOwnReview);
	return null;
}
```

> `new Date().toISOString()` is fine in app code (the `Date.now` restriction applies only to Workflow scripts). Tests pass an explicit `reviewedAt` and never assert on the fallback's timestamp.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/review-state.test.ts --pool=forks --reporter=basic`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review-state.ts src/review-state.test.ts
git commit -m "feat(review-state): KV persistence with GitHub re-parse fallback"
```

---

## Task 6: `triage` module (delta fetch + cheap decision)

**Files:**
- Create: `src/triage.ts`
- Test: `src/triage.test.ts`

- [ ] **Step 1: Write the failing test**

The triage call uses `generateObject`; mock the `ai` module (as `review.test.ts` does for agents) so no network is hit. Test the decode + fail-safe, not the model.

```typescript
import { describe, expect, it, vi } from "vitest";

const mockGenerateObject = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateObject: mockGenerateObject }));
vi.mock("./models.js", () => ({ createAIModel: vi.fn(() => ({})) }));

import { triageReReview } from "./triage.js";

const openFindings = [
	{ id: "src/a.ts:5:bug", path: "src/a.ts", line: 5, title: "Bug", severity: "high", status: "open" as const },
];

describe("triageReReview", () => {
	it("returns the model's SKIP decision with resolved ids", async () => {
		mockGenerateObject.mockResolvedValueOnce({
			object: { recommendation: "SKIP", resolved: ["src/a.ts:5:bug"], newRisk: false },
		});
		const d = await triageReReview({ provider: "anthropic" } as never, "delta diff", openFindings);
		expect(d).toEqual({ recommendation: "SKIP", resolved: ["src/a.ts:5:bug"], newRisk: false });
	});

	it("fails safe to INCREMENTAL (never SKIP) when the model call throws", async () => {
		mockGenerateObject.mockRejectedValueOnce(new Error("boom"));
		const d = await triageReReview({ provider: "anthropic" } as never, "delta diff", openFindings);
		expect(d.recommendation).toBe("INCREMENTAL");
		expect(d.resolved).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/triage.test.ts --pool=forks --reporter=basic`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/triage.ts`:

```typescript
import { generateObject } from "ai";
import { z } from "zod";
import { createAIModel } from "./models.js";
import type { ModelSelection } from "./router.js";
import type { PersistedFinding } from "./review-state.js";

export const TriageSchema = z.object({
	recommendation: z.enum(["SKIP", "INCREMENTAL", "FULL"]),
	resolved: z.array(z.string()),
	newRisk: z.boolean(),
});

export type TriageDecision = z.infer<typeof TriageSchema>;

const FAIL_SAFE: TriageDecision = {
	recommendation: "INCREMENTAL",
	resolved: [],
	newRisk: true,
};

// Cheap, fast triage tier. Reuses the router's selection shape but pins a small
// model + low effort; the call only classifies, it does not review.
function triageSelection(base: ModelSelection): ModelSelection {
	return base.provider === "openai"
		? { provider: "openai", model: "gpt-5.1", effort: "low" }
		: { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
}

export async function triageReReview(
	selection: ModelSelection,
	deltaDiff: string,
	openFindings: PersistedFinding[],
): Promise<TriageDecision> {
	if (openFindings.length === 0 && deltaDiff.trim() === "") {
		return { recommendation: "SKIP", resolved: [], newRisk: false };
	}
	const prompt = [
		"You are triaging whether an AI code reviewer needs to re-review a pull request after a new push.",
		"",
		"Your OPEN findings from the previous review (id — title):",
		...openFindings.map((f) => `- ${f.id} — ${f.title} [${f.severity}]`),
		"",
		"The diff added since your last review (delta only):",
		deltaDiff || "[no code changes in the delta]",
		"",
		"Decide:",
		"- resolved: ids of your open findings that this delta clearly fixes.",
		"- newRisk: true if the delta introduces new code that warrants review.",
		"- recommendation: SKIP if the delta neither touches your findings nor adds reviewable risk (e.g. it addresses another reviewer's feedback); INCREMENTAL if it resolves findings or adds modest new code; FULL only if it is a structural/architectural change.",
	].join("\n");

	try {
		const { object } = await generateObject({
			model: createAIModel(triageSelection(selection)),
			schema: TriageSchema,
			prompt,
			maxOutputTokens: 2000,
		});
		return object;
	} catch (err) {
		console.error("triage call failed; failing safe to INCREMENTAL", { err });
		return FAIL_SAFE;
	}
}

export async function fetchDelta(
	octokit: { request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }> },
	owner: string,
	repo: string,
	baseSha: string,
	headSha: string,
): Promise<string> {
	const res = await octokit.request(
		"GET /repos/{owner}/{repo}/compare/{basehead}",
		{ owner, repo, basehead: `${baseSha}...${headSha}` },
	);
	const data = res.data as { files?: Array<{ filename: string; patch?: string }> };
	return (data.files ?? [])
		.map((f) => `FILE: ${f.filename}\n${f.patch ?? "[no patch]"}`)
		.join("\n\n---\n\n");
}
```

> Verify `ModelSelection` field names against `src/router.ts` before relying on them; the `triageSelection` literals must match the interface (`provider`, `model`, `effort?`). Adjust model ids only if the router exposes named constants — otherwise these literals are acceptable for the triage tier.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/triage.test.ts --pool=forks --reporter=basic`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/triage.ts src/triage.test.ts
git commit -m "feat(triage): cheap re-review decision (SKIP/INCREMENTAL/FULL) with fail-safe"
```

---

## Task 7: Wire the triage gate into `buildReview`

**Files:**
- Modify: `src/review.ts` (`buildReview`, ~lines 604–980; it already computes `priorOwnReview` ~652 and `existingReviews`)
- Test: `src/review.test.ts`

This task connects everything: load state → (prior review exists?) → triage → SKIP/INCREMENTAL/FULL → persist. Keep the existing FULL path intact for the no-prior-review case.

- [ ] **Step 1: Write the failing integration test**

Add a test asserting the SKIP path posts no review and persists `APPROVE` when all findings resolve, using the existing `buildReview` test harness + a fake KV. Mock `./triage.js` to force `SKIP` with the open finding's id in `resolved`.

```typescript
vi.mock("./triage.js", () => ({
	triageReReview: vi.fn(async () => ({ recommendation: "SKIP", resolved: ["src/a.ts:5:bug"], newRisk: false })),
	fetchDelta: vi.fn(async () => "delta"),
}));

it("SKIP path: posts no new review and records APPROVE when findings resolve", async () => {
	// Seed KV state with one open finding matching id "src/a.ts:5:bug" and a prior sha.
	// Build a ctx whose head sha differs from lastReviewedSha and whose existingReviews
	// include this bot's prior review (so priorOwnReview is non-null).
	const decision = await buildReview(makeCtxWithPriorReview());
	expect(decision).toBeNull(); // SKIP → buildReview returns null (nothing to post)
	// And state now has the finding resolved / event APPROVE (assert via the fake KV).
});
```

> Worker note: `makeCtxWithPriorReview` reuses the existing `buildReview` test context factory, but (a) injects a fake `KvClient` (mirror the fake in `src/review-state.test.ts`), (b) pre-seeds `review-state:...` with one open finding, and (c) returns an `existingReviews` array containing a body with `### {commentPrefix}` + `Reviewed commit:` so `priorOwnReview` is populated. If the current harness doesn't thread a KV client into `buildReview`, see Step 3 — the KV client must be obtained the same way the idempotency claim obtains it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/review.test.ts -t "SKIP path" --pool=forks --reporter=basic`
Expected: FAIL — gate not wired; `buildReview` runs the full fan-out.

- [ ] **Step 3: Implement**

In `buildReview`, after `priorOwnReview` is computed (~line 663) and the KV client is available (obtain it the same way the idempotency claim does — via `createUpstashKv()` guarded for absence; if KV is absent, skip straight to FULL), insert the gate BEFORE the agent fan-out:

```typescript
	const kv = createUpstashKv(); // returns null/undefined when unconfigured
	const state = kv
		? await loadReviewState(kv, context.provider, context.owner, context.repo, context.pullNumber, priorOwnReview)
		: null;

	let resolvedKeys = new Set<string>();
	let scopedFiles = files; // FULL by default

	if (kv && state && state.lastReviewedSha && state.lastReviewedSha !== context.headSha) {
		const openFindings = state.findings.filter((f) => f.status === "open");
		const delta = await fetchDelta(context.octokit, context.owner, context.repo, state.lastReviewedSha, context.headSha);
		const triage = await triageReReview(selection, delta, openFindings);

		// Map resolved finding ids → merge keys + flip status in state.
		for (const f of state.findings) {
			if (triage.resolved.includes(f.id)) {
				f.status = "resolved";
				if (f.path && f.line != null) resolvedKeys.add(`inline:${f.path}:${f.line}`);
				resolvedKeys.add(`general:${f.title.toLowerCase().trim()}`);
			}
		}

		if (triage.recommendation === "SKIP") {
			const stillOpen = state.findings.some((f) => f.status === "open");
			state.event = stillOpen ? state.event : "APPROVE";
			state.lastReviewedSha = context.headSha;
			state.reviewedAt = new Date().toISOString();
			await saveReviewState(kv, context.provider, context.owner, context.repo, context.pullNumber, state);
			// Re-stamp the check-run onto the new head carrying the prior conclusion.
			await restampCheckRun(context, state.event);
			return null; // nothing to post to the conversation
		}

		if (triage.recommendation === "INCREMENTAL") {
			// Review only the delta files; build them from the compare payload.
			scopedFiles = await fetchDeltaFiles(context.octokit, context.owner, context.repo, state.lastReviewedSha, context.headSha);
		}
		// FULL falls through with scopedFiles = files.
	}
```

Then:
- Build `userMessage` from `scopedFiles` instead of `files`, and pass `priorOwnReview` into `buildUserMessage` (now supported from Task 4).
- Pass `resolvedKeys` to `mergeReviews(agentResults, resolvedKeys)` (Task 3).
- After a posted review, persist the new state: derive `findings` from the merged result (`findingId(path, line, title)` per inline + general finding, status `open`), set `lastReviewedSha = headSha`, `event = finalEvent`, and `saveReviewState(...)`.

Add a small helper `restampCheckRun(context, conclusion)` that calls the same check-run creation path already used in `github-app.ts`/`check-run.ts` for the new head SHA — reuse `createCheckRun`; do not duplicate its logic. `fetchDeltaFiles` is `fetchDelta`'s sibling returning the raw `files` array (refactor `fetchDelta` to expose both the serialized string and the array, or add a second exported function in `src/triage.ts` that returns `data.files`).

Add imports at the top of `src/review.ts`:

```typescript
import { fetchDelta, fetchDeltaFiles, triageReReview } from "./triage.js";
import { findingId, loadReviewState, saveReviewState } from "./review-state.js";
```

> Worker note: if obtaining the KV client inside `buildReview` is awkward (it currently lives in `github-app.ts`), thread an optional `kv?: KvClient` through `ReviewContext` instead and have `maybeSubmitReview` pass the one it already constructs. Prefer threading over a second `createUpstashKv()` call. Pick ONE approach and keep it consistent.

- [ ] **Step 4: Run the full suite + gates**

Run: `npm run typecheck && npm run lint && npx vitest run --pool=forks --reporter=basic`
Expected: all PASS. Fix lint with `npm run lint -- --write` if needed.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/triage.ts src/review.test.ts
git commit -m "feat(review): wire triage gate into buildReview (SKIP/INCREMENTAL/FULL)"
```

---

## Task 8: End-to-end multi-bot scenario test

**Files:**
- Test: `src/review.test.ts`

- [ ] **Step 1: Write the scenario test**

Drive three `buildReview` calls against one fake KV, mocking `./triage.js` per call:

```typescript
it("multi-bot flow: SKIP another bot's fix, then INCREMENTAL→APPROVE on my fix", async () => {
	const kv = makeFakeKv();
	// 1) sha1: no prior state → FULL → posts REQUEST_CHANGES with finding "Bug" @ src/a.ts:5
	mockTriage.mockResolvedValueOnce(/* unused: no prior state */ undefined as never);
	const r1 = await buildReview(ctx(kv, { headSha: "sha1" /* + agents return the Bug finding */ }));
	expect(r1?.event).toBe("REQUEST_CHANGES");

	// 2) sha2: another bot's fix, my finding untouched → triage SKIP, resolved=[]
	mockTriage.mockResolvedValueOnce({ recommendation: "SKIP", resolved: [], newRisk: false });
	const r2 = await buildReview(ctx(kv, { headSha: "sha2" }));
	expect(r2).toBeNull();

	// 3) sha3: resolves my finding → triage INCREMENTAL, resolved=[bug id], agents find nothing new
	mockTriage.mockResolvedValueOnce({ recommendation: "INCREMENTAL", resolved: ["src/a.ts:5:bug"], newRisk: false });
	const r3 = await buildReview(ctx(kv, { headSha: "sha3" }));
	expect(r3?.event).toBe("APPROVE");
});
```

> Worker note: `ctx`, `makeFakeKv`, and the agent-result mocking all reuse existing harness helpers from `review.test.ts`. The agents must be mocked to return the "Bug" finding on sha1 and nothing on sha3 (the file already mocks `./prompt.js` and the agent path — follow that pattern). `mockTriage` is `vi.mocked(triageReReview)`.

- [ ] **Step 2: Run it**

Run: `npx vitest run src/review.test.ts -t "multi-bot flow" --pool=forks --reporter=basic`
Expected: PASS.

- [ ] **Step 3: Full gates + commit**

```bash
npm run typecheck && npm run lint && npx vitest run --pool=forks --reporter=basic
git add src/review.test.ts
git commit -m "test(review): end-to-end multi-bot SKIP→INCREMENTAL→APPROVE flow"
```

---

## Task 9: `.env.example` + docs

**Files:**
- Modify: `.env.example`, `CLAUDE.md` (env var table)

- [ ] **Step 1: Document the flag**

Add to `.env.example`:

```bash
# Tier 2 review skills. Kept OFF until the QStash scheduler (PR2) frees the full
# 800s function budget; ON would run up to ~8 agents and risk the maxDuration kill.
REVIEW_TIER2_ENABLED=false
```

Add `REVIEW_TIER2_ENABLED` to the "Shared behavior" env list in `CLAUDE.md`.

- [ ] **Step 2: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: document REVIEW_TIER2_ENABLED flag"
```

---

## Final verification

- [ ] `npm run typecheck` — clean
- [ ] `npm run lint` — clean (`npm run lint -- --write` to autofix)
- [ ] `npx vitest run --pool=forks --reporter=basic` — all green
- [ ] Push branch, open PR1 targeting `main`, reference epic `ai-review-bot-9nv`
- [ ] Confirm `REVIEW_TIER2_ENABLED` is unset/false in Vercel prod before merge (so Tier 2 stays off)

---

## Self-Review (completed by author)

- **Spec coverage:** per-bot KV state (Task 5) ✓; cold fallback→FULL (Task 5/7) ✓; triage gate SKIP/INCREMENTAL/FULL (Task 6/7) ✓; SKIP posts nothing + check-run re-stamp (Task 7) ✓; priorOwnReview into agents (Task 4) ✓; drop-resolved + relaxed event (Task 3) ✓; trimPatch cap (Task 4) ✓; Tier 2 interlock OFF (Task 1/2) ✓; triage-error→review, never SKIP (Task 6) ✓; multi-bot e2e (Task 8) ✓. QStash scheduler is intentionally PR2 (separate plan).
- **Placeholder scan:** the few "Worker note" callouts point at *existing* harness helpers rather than re-deriving them; that is deliberate (reuse, not placeholder). All new modules have complete code. The check-run re-stamp reuses `createCheckRun` rather than restating it.
- **Type consistency:** `findingId(path,line,title)` signature is consistent across Tasks 3/5/7; `mergeReviews(results, resolved)` consistent Tasks 3/7; `TriageDecision` fields (`recommendation`,`resolved`,`newRisk`) consistent Tasks 6/7/8; `ReviewState`/`PersistedFinding` consistent Tasks 5/7.
- **Risk flagged for the implementer:** the exact KV-threading approach into `buildReview` (re-construct vs. thread through `ReviewContext`) is left as a single explicit decision in Task 7; pick one and keep it consistent. Verify `ModelSelection` field names + model ids against `src/router.ts` (Task 6) before committing.
