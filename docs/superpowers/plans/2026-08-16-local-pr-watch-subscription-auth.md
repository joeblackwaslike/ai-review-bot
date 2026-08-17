# Local PR Watch — Subscription-Auth Re-Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ai-review watch --pr <n>`, a local CLI command that polls an already-open PR and re-reviews it on every push using local Claude Max/ChatGPT Pro subscription auth instead of funded API keys, posting through the same GitHub App bot identities production uses.

**Architecture:** Thread an optional `auth` param through the existing `maybeSubmitReview()` → `buildReview()` → `runAgent()`/`generateSummary()` call chain (mirroring the pattern `audit.ts` already uses), add a small `watchPr()` polling driver that calls `maybeSubmitReview` directly with `force: true` (bypassing the QStash peer-wait logic, same as the manual `/ai-review` slash command), and wire a new CLI subcommand around it.

**Tech Stack:** TypeScript (ESM), Vitest, Octokit (`octokit` App SDK).

**Spec:** [docs/superpowers/specs/2026-08-16-local-pr-watch-subscription-auth-design.md](../specs/2026-08-16-local-pr-watch-subscription-auth-design.md)

---

### Task 1: Fix the stale `gpt-5.1` Codex model constant

**Files:**
- Modify: `src/router.ts:82-93`
- Modify: `src/models.ts:124-130`
- Test: `src/router.test.ts:1753-1784`

- [ ] **Step 1: Update the failing assertions in `src/router.test.ts`**

Replace the `describe("routeModel — OpenAI", ...)` block (currently lines 1753-1784) with:

```typescript
describe("routeModel — OpenAI", () => {
	it("trivial tier → gpt-5.4, none effort", () => {
		const sel = routeModel(
			{ ...base, additions: 8, deletions: 3, filePaths: ["README.md"] },
			"openai",
		);
		expect(sel.provider).toBe("openai");
		expect(sel.model).toBe("gpt-5.4");
		expect(sel.effort).toBe("none");
	});

	it("normal tier → gpt-5.4, low effort", () => {
		const sel = routeModel(base, "openai");
		expect(sel.model).toBe("gpt-5.4");
		expect(sel.effort).toBe("low");
	});

	it("complex tier → gpt-5.4, high effort", () => {
		const sel = routeModel(
			{ ...base, filePaths: ["src/auth/handler.ts"] },
			"openai",
		);
		expect(sel.model).toBe("gpt-5.4");
		expect(sel.effort).toBe("high");
	});

	it("deep tier → gpt-5.5, high effort (distinguished by the model bump)", () => {
		const sel = routeModel({ ...base, labels: ["deep-review"] }, "openai");
		expect(sel.model).toBe("gpt-5.5");
		expect(sel.effort).toBe("high");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/router.test.ts`
Expected: FAIL — the three non-deep tests report `expected 'gpt-5.1' to be 'gpt-5.4'`.

- [ ] **Step 3: Fix `src/router.ts`**

Replace the `OPENAI_TIER_MAP` constant (currently lines 82-93) with:

```typescript
const OPENAI_TIER_MAP: Record<
	ReviewTier,
	Pick<ModelSelection, "model" | "effort">
> = {
	// gpt-5.1 retired from the ChatGPT/Codex-account backend (confirmed live:
	// "not supported when using Codex with a ChatGPT account") — moved to
	// gpt-5.4, the next tier down from gpt-5.5 that's still served.
	trivial: { model: "gpt-5.4", effort: "none" },
	normal: { model: "gpt-5.4", effort: "low" },
	complex: { model: "gpt-5.4", effort: "high" },
	// gpt-5.5 caps reasoning at "high"; "xhigh" is unverified on the OpenAI API,
	// so deep stays at "high" until support is confirmed. The model bump
	// (gpt-5.4 → gpt-5.5) is what distinguishes deep from complex here.
	deep: { model: "gpt-5.5", effort: "high" },
};
```

- [ ] **Step 4: Fix `src/models.ts`**

Replace the `TOKEN_RATES` constant (currently lines 124-130) with:

```typescript
const TOKEN_RATES: Record<string, { input: number; output: number }> = {
	"claude-haiku-4-5": { input: 1.0, output: 5.0 },
	"claude-sonnet-4-6": { input: 3.0, output: 15.0 },
	"claude-opus-4-8": { input: 5.0, output: 25.0 },
	// gpt-5.1 rate retired below — the ChatGPT/Codex-account backend no longer
	// serves gpt-5.1, and OPENAI_TIER_MAP no longer selects it either.
	"gpt-5.4": { input: 1.25, output: 10.0 }, // carries gpt-5.1's rate as an estimate pending confirmed pricing
	"gpt-5.5": { input: 5.0, output: 30.0 },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/router.test.ts src/models.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/router.ts src/models.ts src/router.test.ts
git commit -m "fix(router): retire stale gpt-5.1 Codex model, move to gpt-5.4

The ChatGPT/Codex-account backend no longer serves gpt-5.1 (\"not
supported when using Codex with a ChatGPT account\"), which silently
broke every OpenAI subscription-auth review. gpt-5.1 still works via a
raw API key, which is why this wasn't caught by the funded webhook
path."
```

---

### Task 2: Thread `auth` through `buildReview`/`generateSummary` in `src/review.ts`

**Files:**
- Modify: `src/review.ts:39-67` (`ReviewContext`), `src/review.ts:546-654` (`generateSummary`), `src/review.ts:1170-1176` (`runAgent` call site), `src/review.ts:1405-1418` (`generateSummary` call site)
- Test: `src/review.test.ts`

- [ ] **Step 1: Write the failing test in `src/review.test.ts`**

Add this import to the top import block (after the existing `import { ... } from "./router.js";` line, i.e. after line 16):

```typescript
import { createAIModel } from "./models.js";
```

Add this new `describe` block at the end of the file:

```typescript
describe("buildReview auth threading", () => {
	beforeEach(() => {
		mockGenerateObject.mockReset();
		mockBuildUserMessage.mockReset();
		mockBuildUserMessage.mockReturnValue("user");
		vi.mocked(createAIModel).mockClear();
	});

	it("threads context.auth through to createAIModel for every Tier 1 agent and the summary model", async () => {
		const auth = {
			mode: "oauth" as const,
			provider: "anthropic" as const,
			token: "tok",
			baseURL: "https://api.example.test",
			headers: {},
			fetch: vi.fn() as unknown as typeof fetch,
		};
		const agentResponse = buildGenerateObjectResponse(
			buildModelReview({
				event: "REQUEST_CHANGES",
				general_findings: [
					{ title: "Something", body: "needs work", severity: "high" },
				],
				inline_comments: [],
			}),
		);
		const summaryResponse = {
			object: { summary: "Found an issue." },
			usage: { inputTokens: 50, outputTokens: 20 },
		};
		mockGenerateObject
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(agentResponse)
			.mockResolvedValueOnce(summaryResponse);

		await buildReview({
			octokit: buildOctokit(),
			...baseContext,
			auth,
		});

		// 5 Tier 1 agent calls + 1 summary call, every one threaded with the same auth.
		expect(createAIModel).toHaveBeenCalledTimes(6);
		for (const call of vi.mocked(createAIModel).mock.calls) {
			expect(call[1]).toBe(auth);
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/review.test.ts -t "threads context.auth"`
Expected: FAIL — `expect(createAIModel).toHaveBeenCalledTimes(6)` fails because every `call[1]` is `undefined` (or the test errors because `ReviewContext` doesn't accept `auth` yet, depending on how strict the object literal check is — either way, red).

- [ ] **Step 3: Add `auth` to `ReviewContext`**

In `src/review.ts`, replace the `ReviewContext` interface (currently lines 39-67) with:

```typescript
interface ReviewContext {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	title: string;
	body: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
	labels: string[];
	commentPrefix: string;
	extraInstructions: string;
	force: boolean;
	provider: "anthropic" | "openai";
	feedbackEnabled: boolean;
	agentConcurrency: number;
	/** Wall-clock allowance for launching agents. Past it the remaining agents are
	 * skipped and the review is submitted with what completed — the platform's own
	 * timeout would otherwise kill the run with nothing posted at all. */
	agentBudgetMs: number;
	tier2Enabled: boolean;
	/** Upstash KV client for review-state persistence + the triage gate. Reuses
	 * the client maybeSubmitReview already built for the idempotency claim; absent
	 * (null/undefined) when KV is not configured or on a forced re-review, in
	 * which case the gate is skipped and a full review runs (legacy behavior). */
	kv?: KvClient | null;
	/** Local subscription/OAuth or explicit API-key auth for this review's model
	 * calls. Omitted on the hosted webhook path (env-var API keys apply via
	 * createAIModel's own fallback); supplied by `ai-review watch` for local,
	 * subscription-authenticated review of an already-open PR. */
	auth?: ResolvedAuth;
}
```

- [ ] **Step 4: Thread `auth` into the `runAgent` call site**

In `src/review.ts`, replace the `runAgent` call (currently lines 1170-1176) with:

```typescript
			const outcome = await runAgent(
				skillPath,
				userMessage,
				selection,
				customPrompt,
				{
					auth: context.auth,
					prompt: { strictEvidenceRules: tuning.strictEvidenceRules },
				},
			);
```

- [ ] **Step 5: Add an `auth` param to `generateSummary` and thread it into `createAIModel`**

In `src/review.ts`, replace the `generateSummary` function signature (currently lines 546-563) with:

```typescript
export async function generateSummary(
	merged: ModelReview,
	selection: ModelSelection,
	context: {
		title: string;
		body: string | null;
		additions: number;
		deletions: number;
		changedFiles: number;
	},
	priorOwnReview: string | null,
	survivingPrior: PersistedFinding[] = [],
	/** Findings resolved by the current triage pass specifically — not every
	 * historical tombstone in persisted state. A finding resolved in an earlier
	 * round but since reintroduced and re-flagged by this round's agents must
	 * not appear here, or the summary would call a live blocker fixed. */
	resolvedThisRound: PersistedFinding[] = [],
	auth?: ResolvedAuth,
): Promise<{ summary: string; usage: TokenUsage }> {
```

Then replace the `generateObject` call inside it (currently lines 638-645) with:

```typescript
	const { object, usage } = await generateObject({
		model: createAIModel(selection, auth),
		schema: SummarySchema,
		maxOutputTokens: outputBudget(selection, 256),
		providerOptions: reasoningProviderOptions(selection),
		system,
		messages: [{ role: "user", content: prompt }],
	});
```

- [ ] **Step 6: Pass `context.auth` at the `generateSummary` call site**

In `src/review.ts`, replace the `generateSummary(...)` call (currently lines 1405-1418) with:

```typescript
			const summaryResult = await generateSummary(
				modelReview,
				selection,
				{
					title: context.title,
					body: context.body,
					additions: context.additions,
					deletions: context.deletions,
					changedFiles: context.changedFiles,
				},
				priorOwnReview,
				survivingPrior,
				resolvedThisRound,
				context.auth,
			);
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/review.test.ts`
Expected: PASS — the new test passes, and every pre-existing test in the file still passes unchanged (they never set `context.auth`, so `auth` stays `undefined` — identical to today's behavior).

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add src/review.ts src/review.test.ts
git commit -m "feat(review): thread auth through buildReview and generateSummary

ReviewContext gains an optional auth field, threaded into every
runAgent call and the summary-generation model call. Omitted on the
hosted webhook path (unchanged behavior — falls back to env-var API
keys); will be supplied by the upcoming ai-review watch command."
```

---

### Task 3: Thread `auth` through `maybeSubmitReview` in `src/github-app.ts`

**Files:**
- Modify: `src/github-app.ts:1-4` (imports), `src/github-app.ts:248-268` (args type + destructuring), `src/github-app.ts:478-503` (`buildReview` call)
- Test: `src/github-app.test.ts`

- [ ] **Step 1: Write the failing tests in `src/github-app.test.ts`**

Add these two tests at the end of the `describe("maybeSubmitReview", ...)` block:

```typescript
	it("threads auth through to buildReview when provided", async () => {
		const { app } = buildMockApp();
		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});
		const auth = {
			mode: "oauth" as const,
			provider: "anthropic" as const,
			token: "tok",
			baseURL: "https://api.example.test",
			headers: {},
			fetch: vi.fn() as unknown as typeof fetch,
		};

		await maybeSubmitReview({ app, ...baseArgs, auth });

		expect(mockBuildReview).toHaveBeenCalledWith(
			expect.objectContaining({ auth }),
		);
	});

	it("passes auth as undefined when not provided (unchanged webhook behavior)", async () => {
		const { app } = buildMockApp();
		mockBuildReview.mockReset().mockResolvedValue({
			event: "COMMENT" as const,
			body: "Review body.",
			comments: [],
			metadata: DEFAULT_METADATA,
		});

		await maybeSubmitReview({ app, ...baseArgs });

		expect(mockBuildReview).toHaveBeenCalledWith(
			expect.objectContaining({ auth: undefined }),
		);
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/github-app.test.ts -t "threads auth"`
Expected: FAIL — either a TypeScript error (`auth` not assignable, if running via `vitest` which uses esbuild and won't type-check) or, more likely, the test runs but `mockBuildReview` was never called with an `auth` key at all, so `toHaveBeenCalledWith(expect.objectContaining({ auth }))` fails because the actual call has no `auth` property.

- [ ] **Step 3: Add the import**

In `src/github-app.ts`, insert this line after line 1 (`import { App } from "octokit";`):

```typescript
import type { ResolvedAuth } from "./auth.js";
```

- [ ] **Step 4: Add `auth` to `maybeSubmitReview`'s args type and destructuring**

In `src/github-app.ts`, replace the function opening (currently lines 248-268, up through the destructuring block) with:

```typescript
export async function maybeSubmitReview(args: {
	app: App;
	installationId: number;
	owner: string;
	repo: string;
	pullNumber: number;
	pullRequest: PullRequestDetails;
	extraInstructions: string;
	force: boolean;
	config: AppConfig;
	auth?: ResolvedAuth;
}) {
	const {
		app,
		installationId,
		owner,
		repo,
		pullNumber,
		pullRequest,
		extraInstructions,
		force,
		config,
		auth,
	} = args;
```

- [ ] **Step 5: Pass `auth` into the `buildReview` call**

In `src/github-app.ts`, in the `buildReview({...})` call (currently lines 478-503), add `auth,` as the last field before the closing `});`:

```typescript
		review = await buildReview({
			octokit,
			owner,
			repo,
			pullNumber,
			headSha,
			title: pullRequest.title,
			body: pullRequest.body,
			additions: pullRequest.additions,
			deletions: pullRequest.deletions,
			changedFiles: pullRequest.changed_files,
			labels: pullRequest.labels?.map((l) => l.name) ?? [],
			commentPrefix: config.reviewCommentPrefix,
			extraInstructions,
			force,
			provider: config.provider,
			feedbackEnabled: config.feedbackEnabled,
			agentConcurrency: config.agentConcurrency,
			agentBudgetMs: config.agentBudgetMs,
			tier2Enabled: config.tier2Enabled,
			// Unconditional KV (not the force-gated claim client) for review-state
			// persistence + the triage gate. Null only when KV is unconfigured. A
			// forced review still persists fresh state here; buildReview force-gates
			// the gate itself so force runs a FULL review but doesn't go stale (I1).
			kv: stateKv,
			auth,
		});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/github-app.test.ts`
Expected: PASS — the two new tests pass, and every pre-existing test in the file still passes (none of them assert the exact call-args object, so the new `auth` field doesn't break them).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/github-app.ts src/github-app.test.ts
git commit -m "feat(github-app): thread auth through maybeSubmitReview

Optional auth param on maybeSubmitReview's args, passed straight
through to buildReview (Task 2 already threads it the rest of the
way). Unchanged for every existing webhook caller, which never sets
it — this is the wiring the upcoming ai-review watch command needs to
call maybeSubmitReview with local subscription auth."
```

---

### Task 4: Add `installationApp()` to `src/improve/octokit.ts`

**Files:**
- Modify: `src/improve/octokit.ts` (full file, 21 lines)
- Test: `src/improve/octokit.test.ts`

- [ ] **Step 1: Write the failing test in `src/improve/octokit.test.ts`**

Replace the existing `const { installationOctokit } = await import("./octokit.js");` line (line 12) with:

```typescript
const { installationApp, installationOctokit } = await import("./octokit.js");
```

Add this new `describe` block at the end of the file:

```typescript
describe("installationApp", () => {
	it("resolves the installation id and returns both the App and the id", async () => {
		requestMock.mockResolvedValue({ data: { id: 99 } });

		const result = await installationApp(
			"app-1",
			"-----BEGIN...",
			"owner",
			"repo",
		);

		expect(requestMock).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/installation",
			{ owner: "owner", repo: "repo" },
		);
		expect(result.installationId).toBe(99);
		expect(AppCtor).toHaveBeenCalledWith({
			appId: "app-1",
			privateKey: "-----BEGIN...",
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/improve/octokit.test.ts`
Expected: FAIL — `installationApp` is not exported from `./octokit.js`.

- [ ] **Step 3: Implement `installationApp()` and refactor `installationOctokit()` to reuse it**

Replace the full contents of `src/improve/octokit.ts` with:

```typescript
import { App } from "octokit";

/** Build an App instance plus its resolved installation id for one GitHub App
 * on a repo. Base for installationOctokit() below and for any caller (e.g.
 * `ai-review watch`) that needs the App object itself rather than a
 * ready-made Octokit — maybeSubmitReview() takes {app, installationId}
 * directly, not an Octokit. */
export async function installationApp(
	appId: string,
	privateKey: string,
	owner: string,
	repo: string,
): Promise<{ app: App; installationId: number }> {
	const app = new App({
		appId,
		privateKey: privateKey.replaceAll(String.raw`\n`, "\n"),
	});
	const { data: inst } = await app.octokit.request(
		"GET /repos/{owner}/{repo}/installation",
		{ owner, repo },
	);
	return { app, installationId: inst.id };
}

/** Build an Octokit authenticated as one GitHub App's installation on a repo.
 * Shared by the CLI (`ai-review propose`/`ready`/`backfill`/`watch`), the
 * weekly cron (`api/cron/improve.ts`), and the dashboard's "open issue from
 * metric" action. */
export async function installationOctokit(
	appId: string,
	privateKey: string,
	owner: string,
	repo: string,
) {
	const { app, installationId } = await installationApp(
		appId,
		privateKey,
		owner,
		repo,
	);
	return app.getInstallationOctokit(installationId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/improve/octokit.test.ts`
Expected: PASS — the new test passes, and the two pre-existing `installationOctokit` tests still pass unchanged (same `App` construction and call sequence, just routed through the new helper).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/improve/octokit.ts src/improve/octokit.test.ts
git commit -m "feat(improve/octokit): add installationApp() helper

Extracts the App-construction + installation-lookup logic
installationOctokit() already did into its own exported function that
returns {app, installationId} instead of a ready-made Octokit —
maybeSubmitReview() needs the App object directly. installationOctokit()
is refactored to call it, unchanged externally."
```

---

### Task 5: Watch driver — `src/watch.ts`

**Files:**
- Create: `src/watch.ts`
- Test: `src/watch.test.ts`

- [ ] **Step 1: Write the failing tests in `src/watch.test.ts`**

Create `src/watch.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { watchPr } from "./watch.js";

function buildTarget(provider: "anthropic" | "openai") {
	return {
		provider,
		app: { marker: `${provider}-app` } as never,
		installationId: provider === "anthropic" ? 1 : 2,
		config: { provider } as unknown as AppConfig,
	};
}

function pollResponse(
	overrides: Partial<{
		merged: boolean;
		state: string;
		headSha: string;
	}> = {},
) {
	return {
		data: {
			merged: overrides.merged ?? false,
			state: overrides.state ?? "open",
			draft: false,
			head: { sha: overrides.headSha ?? "sha1" },
			additions: 1,
			deletions: 0,
			changed_files: 1,
			title: "Test PR",
			body: null,
		},
	};
}

const apiKeyAuth = {
	mode: "api-key" as const,
	provider: "anthropic" as const,
	apiKey: "k",
};

describe("watchPr", () => {
	it("posts once per provider on the first cycle, then not again while the SHA is unchanged", async () => {
		const request = vi.fn().mockResolvedValue(pollResponse());
		const submitReview = vi.fn().mockResolvedValue(undefined);
		const resolveAuthFor = vi.fn(async (provider: "anthropic" | "openai") => ({
			...apiKeyAuth,
			provider,
		}));
		const sleep = vi.fn().mockResolvedValue(undefined);

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic"), buildTarget("openai")],
			resolveAuthFor,
			sleep,
			log: () => {},
			submitReview,
			maxCycles: 3,
		});

		expect(result).toEqual({ cycles: 3, reason: "max-cycles" });
		expect(submitReview).toHaveBeenCalledTimes(2);
		expect(resolveAuthFor).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(3);
	});

	it("re-reviews once per provider when the head SHA changes", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(pollResponse({ headSha: "sha1" }))
			.mockResolvedValueOnce(pollResponse({ headSha: "sha2" }))
			.mockResolvedValue(pollResponse({ headSha: "sha2" }));
		const submitReview = vi.fn().mockResolvedValue(undefined);

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic")],
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
			sleep: vi.fn().mockResolvedValue(undefined),
			log: () => {},
			submitReview,
			maxCycles: 3,
		});

		expect(result.reason).toBe("max-cycles");
		// cycle 1 (sha1) + cycle 2 (sha2), not cycle 3 (sha2 again)
		expect(submitReview).toHaveBeenCalledTimes(2);
	});

	it("exits when the PR is merged", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(pollResponse())
			.mockResolvedValueOnce(pollResponse({ merged: true }));

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic")],
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
			sleep: vi.fn().mockResolvedValue(undefined),
			log: () => {},
			submitReview: vi.fn().mockResolvedValue(undefined),
		});

		expect(result).toEqual({ cycles: 2, reason: "merged" });
	});

	it("exits when the PR is closed (not merged)", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(pollResponse({ state: "closed" }));

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic")],
			resolveAuthFor: vi.fn(),
			sleep: vi.fn().mockResolvedValue(undefined),
			log: () => {},
			submitReview: vi.fn(),
		});

		expect(result).toEqual({ cycles: 1, reason: "closed" });
	});

	it("logs and retries past a single transient poll failure instead of exiting", async () => {
		const request = vi
			.fn()
			.mockRejectedValueOnce(new Error("ETIMEDOUT"))
			.mockResolvedValueOnce(pollResponse({ merged: true }));
		const log = vi.fn();

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic")],
			resolveAuthFor: vi.fn(),
			sleep: vi.fn().mockResolvedValue(undefined),
			log,
			submitReview: vi.fn(),
		});

		expect(result).toEqual({ cycles: 2, reason: "merged" });
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("poll failed, retrying next interval"),
		);
	});

	it("propagates an auth-resolution failure instead of retrying forever", async () => {
		const request = vi.fn().mockResolvedValue(pollResponse());
		const resolveAuthFor = vi
			.fn()
			.mockRejectedValue(new Error("run `claude` to log in"));

		await expect(
			watchPr({
				owner: "o",
				repo: "r",
				pullNumber: 5,
				pollOctokit: { request },
				targets: [buildTarget("anthropic")],
				resolveAuthFor,
				sleep: vi.fn().mockResolvedValue(undefined),
				log: () => {},
				submitReview: vi.fn(),
			}),
		).rejects.toThrow(/run `claude` to log in/);
	});

	it("logs and continues when one provider's submitReview fails, still reviewing the other", async () => {
		const request = vi.fn().mockResolvedValue(pollResponse());
		const submitReview = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(undefined);
		const log = vi.fn();

		const result = await watchPr({
			owner: "o",
			repo: "r",
			pullNumber: 5,
			pollOctokit: { request },
			targets: [buildTarget("anthropic"), buildTarget("openai")],
			resolveAuthFor: vi.fn().mockResolvedValue(apiKeyAuth),
			sleep: vi.fn().mockResolvedValue(undefined),
			log,
			submitReview,
			maxCycles: 1,
		});

		expect(result).toEqual({ cycles: 1, reason: "max-cycles" });
		expect(submitReview).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("review failed, continuing"),
		);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/watch.test.ts`
Expected: FAIL — `Cannot find module './watch.js'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `src/watch.ts`**

Create `src/watch.ts`:

```typescript
import type { App } from "octokit";
import type { OctokitLike } from "./audit-pr.js";
import type { Provider, ResolvedAuth } from "./auth.js";
import type { AppConfig } from "./config.js";
import { maybeSubmitReview } from "./github-app.js";

/** Enough of the GET /pulls/{n} response shape for watchPr's own merged/closed
 * check plus everything maybeSubmitReview's pullRequest param needs. */
interface PolledPullRequest {
	merged: boolean;
	state: string;
	draft: boolean;
	head: { sha: string };
	additions: number;
	deletions: number;
	changed_files: number;
	title: string;
	body: string | null;
	labels?: Array<{ name: string }>;
}

export interface ProviderTarget {
	provider: Provider;
	app: App;
	installationId: number;
	config: AppConfig;
}

export interface WatchPrOptions {
	owner: string;
	repo: string;
	pullNumber: number;
	pollOctokit: OctokitLike;
	targets: ProviderTarget[];
	resolveAuthFor: (provider: Provider) => Promise<ResolvedAuth>;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	log?: (msg: string) => void;
	submitReview?: typeof maybeSubmitReview;
	/** Test-only escape hatch: stop after this many poll cycles regardless of
	 * PR state. Unset in production — the loop runs until merged/closed. */
	maxCycles?: number;
}

export interface WatchResult {
	cycles: number;
	reason: "merged" | "closed" | "max-cycles";
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Polls an already-open PR and re-reviews it on every new push, posting
 * through the same GitHub App installation identities production uses —
 * driven by local subscription auth (resolveAuthFor) instead of API keys.
 * Exits once the PR merges or closes. See
 * docs/superpowers/specs/2026-08-16-local-pr-watch-subscription-auth-design.md.
 */
export async function watchPr(opts: WatchPrOptions): Promise<WatchResult> {
	const {
		owner,
		repo,
		pullNumber,
		pollOctokit,
		targets,
		resolveAuthFor,
		intervalMs = 60_000,
		sleep = defaultSleep,
		log = console.log,
		submitReview = maybeSubmitReview,
		maxCycles,
	} = opts;

	let lastReviewedSha: string | null = null;
	let cycles = 0;

	while (true) {
		cycles += 1;

		let pr: PolledPullRequest;
		try {
			const response = await pollOctokit.request<PolledPullRequest>(
				"GET /repos/{owner}/{repo}/pulls/{pull_number}",
				{ owner, repo, pull_number: pullNumber },
			);
			pr = response.data;
		} catch (err) {
			log(
				`ai-review watch: poll failed, retrying next interval: ${errMsg(err)}`,
			);
			if (maxCycles !== undefined && cycles >= maxCycles) {
				return { cycles, reason: "max-cycles" };
			}
			await sleep(intervalMs);
			continue;
		}

		if (pr.merged || pr.state === "closed") {
			log(
				`ai-review watch: PR #${pullNumber} is ${pr.merged ? "merged" : "closed"} — exiting`,
			);
			return { cycles, reason: pr.merged ? "merged" : "closed" };
		}

		if (pr.head.sha !== lastReviewedSha) {
			for (const target of targets) {
				// Not caught here: an auth-resolution failure (e.g. the local
				// subscription session logged out mid-watch) propagates out of
				// watchPr entirely, surfacing auth.ts's own "run `claude`/`codex
				// login`" error instead of retrying forever with no signal.
				const auth = await resolveAuthFor(target.provider);
				try {
					await submitReview({
						app: target.app,
						installationId: target.installationId,
						owner,
						repo,
						pullNumber,
						pullRequest: pr,
						extraInstructions: "",
						force: true,
						config: target.config,
						auth,
					});
					log(
						`ai-review watch: posted ${target.provider} review for ${pr.head.sha}`,
					);
				} catch (err) {
					log(
						`ai-review watch: ${target.provider} review failed, continuing: ${errMsg(err)}`,
					);
				}
			}
			lastReviewedSha = pr.head.sha;
		}

		if (maxCycles !== undefined && cycles >= maxCycles) {
			return { cycles, reason: "max-cycles" };
		}
		await sleep(intervalMs);
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/watch.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/watch.ts src/watch.test.ts
git commit -m "feat(watch): add watchPr() polling driver

Polls an open PR, re-reviews on head-SHA change by calling
maybeSubmitReview directly with force:true (the same immediate path
the manual /ai-review slash command already uses — no QStash
peer-wait), and exits on merge/close. Auth-resolution failures
propagate and stop the loop; a single provider's review failure or a
transient poll failure just logs and continues."
```

---

### Task 6: CLI surface — `ai-review watch`

**Files:**
- Modify: `src/cli.ts` (imports, `usage()`, new `cmdWatch()`, dispatch in `main()`)
- Test: `src/cli.test.ts`

- [ ] **Step 1: Write the failing tests in `src/cli.test.ts`**

Replace the full contents of `src/cli.test.ts` with (adds mocks/imports for `watchPr`/`installationApp`/`installationOctokit` and a new `describe("cmdWatch", ...)` block; everything under the existing `describe("cmdAudit credential validation", ...)` is unchanged):

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (orig) => {
	const actual = await orig<typeof import("./config.js")>();
	return { ...actual, getConfig: vi.fn(), getOpenAIAppConfig: vi.fn() };
});
vi.mock("./audit.js", async (orig) => {
	const actual = await orig<typeof import("./audit.js")>();
	return { ...actual, runLocalAudit: vi.fn() };
});
vi.mock("./improve/octokit.js", async (orig) => {
	const actual = await orig<typeof import("./improve/octokit.js")>();
	return {
		...actual,
		installationApp: vi.fn(),
		installationOctokit: vi.fn(),
	};
});
vi.mock("./watch.js", async (orig) => {
	const actual = await orig<typeof import("./watch.js")>();
	return { ...actual, watchPr: vi.fn() };
});

import { runLocalAudit } from "./audit.js";
import { cmdAudit, cmdWatch } from "./cli.js";
import { getConfig, getOpenAIAppConfig } from "./config.js";
import { installationApp, installationOctokit } from "./improve/octokit.js";
import { watchPr } from "./watch.js";

class ProcessExitError extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

describe("cmdAudit credential validation", () => {
	beforeEach(() => {
		vi.mocked(getConfig).mockReset();
		vi.mocked(getOpenAIAppConfig).mockReset();
		vi.mocked(runLocalAudit).mockReset();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitError(code ?? 0);
		}) as never);
	});

	// Regression test for the unsafe `(err as Error).message` cast this diff
	// replaced: getConfig()/getOpenAIAppConfig() are untyped `unknown` at the
	// catch boundary, so a non-Error throw (a string, a plain object — plenty
	// of libraries and hand-rolled validators throw those) must still produce
	// a real, readable fatal message instead of silently printing "Error:
	// undefined", which is what `(err as Error).message` does when `err` has
	// no `.message` property.
	it("prints the real value when a config check throws a non-Error", async () => {
		vi.mocked(getConfig).mockImplementation(() => {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal
			throw "GITHUB_APP_PRIVATE_KEY is not set";
		});

		await expect(cmdAudit([])).rejects.toThrow(ProcessExitError);

		expect(console.error).toHaveBeenCalledWith(
			"Error: GITHUB_APP_PRIVATE_KEY is not set",
		);
		expect(process.exit).toHaveBeenCalledWith(1);
		expect(runLocalAudit).not.toHaveBeenCalled();
	});

	// String(err) on a plain object collapses it to "[object Object]",
	// throwing away whatever detail it carried (and throws outright for a
	// null-prototype object). inspect() preserves that detail instead.
	it("preserves object detail instead of collapsing to [object Object]", async () => {
		vi.mocked(getConfig).mockImplementation(() => {
			// eslint-disable-next-line @typescript-eslint/no-throw-literal
			throw { code: "GITHUB_APP_PRIVATE_KEY is not set" };
		});

		await expect(cmdAudit([])).rejects.toThrow(ProcessExitError);

		const [message] = vi.mocked(console.error).mock.calls[0] as [string];
		expect(message).toContain("GITHUB_APP_PRIVATE_KEY is not set");
		expect(message).not.toContain("[object Object]");
	});

	it("still prints a real Error's message unchanged", async () => {
		vi.mocked(getConfig).mockImplementation(() => {
			throw new Error("OPENAI_APP_ID is not set");
		});

		await expect(cmdAudit([])).rejects.toThrow(ProcessExitError);

		expect(console.error).toHaveBeenCalledWith(
			"Error: OPENAI_APP_ID is not set",
		);
		expect(runLocalAudit).not.toHaveBeenCalled();
	});

	it("skips the credential check entirely for --dry-run", async () => {
		vi.mocked(getConfig).mockImplementation(() => {
			throw new Error("should never be reached");
		});
		vi.mocked(runLocalAudit).mockResolvedValue({
			artifacts: [],
			url: undefined,
			pr: undefined,
		} as unknown as Awaited<ReturnType<typeof runLocalAudit>>);

		await cmdAudit(["--dry-run"]);

		expect(getConfig).not.toHaveBeenCalled();
		expect(process.exit).not.toHaveBeenCalled();
	});
});

describe("cmdWatch", () => {
	beforeEach(() => {
		vi.mocked(getConfig)
			.mockReset()
			.mockReturnValue({
				appId: "claude-app",
				privateKey: "claude-pem",
			} as unknown as ReturnType<typeof getConfig>);
		vi.mocked(getOpenAIAppConfig)
			.mockReset()
			.mockReturnValue({
				appId: "codex-app",
				privateKey: "codex-pem",
			} as unknown as ReturnType<typeof getOpenAIAppConfig>);
		vi.mocked(installationApp)
			.mockReset()
			.mockImplementation(async (appId) => ({
				app: { marker: appId } as never,
				installationId: appId === "claude-app" ? 1 : 2,
			}));
		vi.mocked(installationOctokit)
			.mockReset()
			.mockResolvedValue({ request: vi.fn() } as never);
		vi.mocked(watchPr)
			.mockReset()
			.mockResolvedValue({ cycles: 1, reason: "merged" });
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitError(code ?? 0);
		}) as never);
	});

	it("requires --pr", async () => {
		await expect(cmdWatch(["--repo", "o/r"])).rejects.toThrow(
			ProcessExitError,
		);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("rejects an invalid --provider value", async () => {
		await expect(
			cmdWatch(["--pr", "5", "--repo", "o/r", "--provider", "bogus"]),
		).rejects.toThrow(ProcessExitError);
		expect(watchPr).not.toHaveBeenCalled();
	});

	it("defaults to both providers, 60s interval, and passes the resolved targets to watchPr", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r"]);

		expect(watchPr).toHaveBeenCalledTimes(1);
		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.owner).toBe("o");
		expect(call.repo).toBe("r");
		expect(call.pullNumber).toBe(5);
		expect(call.intervalMs).toBe(60_000);
		expect(call.targets.map((t) => t.provider)).toEqual([
			"anthropic",
			"openai",
		]);
		expect(installationOctokit).toHaveBeenCalledWith(
			"claude-app",
			"claude-pem",
			"o",
			"r",
		);
	});

	it("--provider narrows to a single target", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r", "--provider", "anthropic"]);

		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.targets.map((t) => t.provider)).toEqual(["anthropic"]);
		expect(getOpenAIAppConfig).not.toHaveBeenCalled();
	});

	it("--interval converts seconds to milliseconds", async () => {
		await cmdWatch(["--pr", "5", "--repo", "o/r", "--interval", "15"]);

		const call = vi.mocked(watchPr).mock.calls[0][0];
		expect(call.intervalMs).toBe(15_000);
	});
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run src/cli.test.ts`
Expected: the pre-existing `cmdAudit` tests still PASS; the new `cmdWatch` tests FAIL with `cmdWatch is not a function` / `installationApp`/`watchPr` import errors (none of it exists yet).

- [ ] **Step 3: Add the imports**

In `src/cli.ts`, replace the `import { resolveAnthropicAuth } from "./auth.js";` line (line 32 of the original import block) with:

```typescript
import { resolveAnthropicAuth, resolveAuth } from "./auth.js";
```

Replace the `import { installationOctokit } from "./improve/octokit.js";` line (line 40) with:

```typescript
import {
	installationApp,
	installationOctokit,
} from "./improve/octokit.js";
```

Add this new import after the `./report.js` import (the last import in the block):

```typescript
import { watchPr } from "./watch.js";
```

- [ ] **Step 4: Add the `watch` usage line**

In `src/cli.ts`, in the `usage()` function, insert these lines right after `console.error("  ai-review ready [pr#]");`:

```typescript
	console.error(
		"  ai-review watch --pr <n> [--repo <owner/name>] [--provider anthropic|openai] [--interval <seconds>]",
	);
	console.error(
		"      Poll an open PR and re-review on every push using local subscription",
	);
	console.error(
		"      auth, posting as the same GitHub App bot identities production uses.",
	);
	console.error(
		"      Personal, local use only — exits when the PR merges or closes.",
	);
```

- [ ] **Step 5: Implement `cmdWatch`**

In `src/cli.ts`, add this function after `cmdReady` (i.e. after its closing `}`):

```typescript
async function cmdWatch(args: string[]): Promise<void> {
	let pr: number | undefined;
	let repoArg: string | undefined;
	let providerArg: "anthropic" | "openai" | undefined;
	let intervalSeconds = 60;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--pr") pr = Number(requireValue(args, i++, a));
		else if (a === "--repo") repoArg = requireValue(args, i++, a);
		else if (a === "--provider") {
			const v = requireValue(args, i++, a);
			if (v !== "anthropic" && v !== "openai") {
				fatal(`--provider must be anthropic or openai, got: ${v}`);
			}
			providerArg = v;
		} else if (a === "--interval") {
			intervalSeconds = Number(requireValue(args, i++, a));
		} else if (a.startsWith("--")) fatal(`Unknown flag: ${a}`);
	}
	if (!pr) fatal("--pr <n> is required");

	const { owner, repo } = repoArg
		? { owner: repoArg.split("/")[0], repo: repoArg.split("/")[1] }
		: originSlug();

	const providers: Array<"anthropic" | "openai"> = providerArg
		? [providerArg]
		: ["anthropic", "openai"];

	const targets = [];
	for (const provider of providers) {
		const config =
			provider === "anthropic" ? getConfig() : getOpenAIAppConfig();
		const { app, installationId } = await installationApp(
			config.appId,
			config.privateKey,
			owner,
			repo,
		);
		targets.push({ provider, app, installationId, config });
	}

	const pollOctokit = await installationOctokit(
		targets[0].config.appId,
		targets[0].config.privateKey,
		owner,
		repo,
	);

	console.log(
		`Watching ${owner}/${repo}#${pr} (${providers.join(", ")}) every ${intervalSeconds}s — Ctrl-C to stop early.`,
	);

	const result = await watchPr({
		owner,
		repo,
		pullNumber: pr,
		pollOctokit: pollOctokit as unknown as OctokitLike,
		targets,
		resolveAuthFor: (provider) => resolveAuth(provider),
		intervalMs: intervalSeconds * 1000,
	});

	console.log(`Stopped: ${result.reason} after ${result.cycles} cycle(s).`);
}
```

- [ ] **Step 6: Wire the dispatch**

In `src/cli.ts`, in `main()`, insert this line right after `if (sub === "ready") return cmdReady(rest);`:

```typescript
	if (sub === "watch") return cmdWatch(rest);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/cli.test.ts`
Expected: PASS — all `cmdAudit` and `cmdWatch` tests green.

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean. If `resolveAnthropicAuth` becomes an unused import (check whether `cmdReview` still uses it — it does, per `src/cli.ts`'s existing `cmdReview` function, so no unused-import error is expected; if lint flags it anyway, remove `resolveAnthropicAuth` from the import only if grep confirms zero remaining uses).

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat(cli): add ai-review watch --pr <n>

New subcommand: resolves both (or one, via --provider) GitHub App
installations for the target repo, then hands off to watchPr(). Repo
defaults from the git origin remote, same as audit/ready. This is the
CLI entry point for reviewing an already-open PR with local Claude
Max/ChatGPT Pro subscription auth instead of funded API keys."
```

---

### Task 7: Full quality gates

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all three clean/green, including every test written in Tasks 1-6 plus the full pre-existing suite (no regressions).

- [ ] **Step 2: Manual smoke test (requires local GitHub App creds + subscription login — skip if unavailable and note it in the PR description instead)**

Run against a real throwaway PR in a repo where both GitHub Apps are installed:

```bash
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY npx tsx src/cli.ts watch --pr <n> --interval 30
```

Expected: within one interval, `gh pr view <n> --json reviews` shows a fresh review from both `anthropicreviewbot` and `codexreviewbot` (or whichever `reviewCommentPrefix` values are configured), authenticated via Keychain/`~/.codex/auth.json` rather than any API key. Push a commit to the PR and confirm a second review posts on the next cycle. Close or merge the PR and confirm the process exits with a `Stopped: merged ...` / `Stopped: closed ...` line.

- [ ] **Step 3: Close the loop on the follow-up beads issue**

`ai-review-bot-1uc` (companion docs in `agent-skills`/`agent-harness`) stays open — it's follow-on work in other repos, not part of this plan. No action here beyond confirming it's still tracked: `bd show ai-review-bot-1uc`.
