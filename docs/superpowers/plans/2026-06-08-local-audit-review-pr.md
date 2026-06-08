# Local-Tree Audit → Synthetic-Base Review PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ai-review audit` (local-tree, both-provider) and `ai-review ready` subcommands that produce structured artifacts and a synthetic-base GitHub review PR an agent/`pr-loop` can act on.

**Architecture:** A new local file-collection module feeds a refactored two-provider audit core. Findings are written as JSON/MD artifacts and posted as inline comments on a draft PR whose base is an orphan branch (so whole files are commentable); `ready` retargets that PR onto the default branch for a clean merge. Reuses the existing `runAgent`/`mergeReviews`/`buildReviewComments` pipeline unchanged.

**Tech Stack:** TypeScript ESM, Vitest, Octokit, Vercel AI SDK, Biome. Spec: [docs/superpowers/specs/2026-06-08-local-audit-review-pr-design.md](../specs/2026-06-08-local-audit-review-pr-design.md). Beads: `ai-review-bot-g8y`.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/sources.ts` | create | `hasCodeExtension`, `CODE_EXTENSIONS` (moved from `audit.ts`), `collectFilesFromLocal()` over an injectable git runner |
| `src/sources.test.ts` | create | Unit tests for local collection (changed/full) + extension filtering |
| `src/audit.ts` | modify | Import `hasCodeExtension` from `sources.ts`; extract `runAuditPass()`; add `writeArtifacts()` + `formatAuditJson()`; add `runLocalAudit()` orchestrator |
| `src/audit.test.ts` | create | Two-provider orchestration, dry-run, artifact shape |
| `src/audit-pr.ts` | create | `ensureOrphanBase`, `createHeadBranch`, `openDraftPr` (+`AI audit` label), `postProviderReview`, `makeReady` |
| `src/audit-pr.test.ts` | create | Orphan-diff anchors, two-identity posting, label, `makeReady`, 403 fallback |
| `src/cli.ts` | modify | Subcommand dispatch: `audit`, `ready`, legacy remote |
| `.gitignore` | modify | Ignore `.ai-review/` |

**Scoping choice:** the legacy remote fetch (`auditRepo`'s blob loop) stays in `audit.ts` (deprecated path); only *local* collection moves to `sources.ts`. This keeps Phase-1 refactor risk low while still de-duplicating the new code path.

**Shared types (defined in `src/sources.ts`, imported elsewhere):**

```typescript
export interface AuditFile {
	path: string;
	content: string;
}
export type FileMode = "changed" | "full";
export type GitRunner = (args: readonly string[]) => string;
```

---

## Task 1: Local file collection (`src/sources.ts`)

**Files:**
- Create: `src/sources.ts`
- Test: `src/sources.test.ts`
- Modify: `src/audit.ts` (remove `CODE_EXTENSIONS`/`hasCodeExtension`, import from `sources.ts`)

- [ ] **Step 1: Write the failing test**

```typescript
// src/sources.test.ts
import { describe, expect, it, vi } from "vitest";
import {
	type GitRunner,
	collectFilesFromLocal,
	hasCodeExtension,
} from "./sources.js";

describe("hasCodeExtension", () => {
	it("accepts code files and rejects others", () => {
		expect(hasCodeExtension("src/a.ts")).toBe(true);
		expect(hasCodeExtension("README.md")).toBe(false);
		expect(hasCodeExtension("Makefile")).toBe(false);
	});
});

describe("collectFilesFromLocal", () => {
	const readFile = async (p: string) => `// content of ${p}`;

	it("changed mode = diff names ∪ porcelain, code-filtered, deduped", async () => {
		const runGit: GitRunner = (args) => {
			const key = args.join(" ");
			if (key.startsWith("merge-base")) return "BASE_SHA";
			if (key.startsWith("diff --name-only")) return "src/a.ts\nsrc/b.ts\ndocs/x.md";
			if (key.startsWith("status --porcelain")) return " M src/b.ts\n?? src/c.ts\n?? notes.txt";
			return "";
		};
		const files = await collectFilesFromLocal({ cwd: "/repo", mode: "changed", runGit, readFile });
		expect(files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
		expect(files[0].content).toContain("content of");
	});

	it("full mode = git ls-files, code-filtered", async () => {
		const runGit: GitRunner = (args) =>
			args[0] === "ls-files" ? "src/a.ts\nREADME.md\nsrc/d.tsx" : "";
		const files = await collectFilesFromLocal({ cwd: "/repo", mode: "full", runGit, readFile });
		expect(files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/d.tsx"]);
	});

	it("skips files that fail to read (deleted/binary)", async () => {
		const runGit: GitRunner = (args) =>
			args[0] === "ls-files" ? "src/a.ts\nsrc/gone.ts" : "";
		const failingRead = async (p: string) => {
			if (p.endsWith("gone.ts")) throw new Error("ENOENT");
			return "ok";
		};
		const files = await collectFilesFromLocal({ cwd: "/repo", mode: "full", runGit, readFile: failingRead });
		expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources.test.ts`
Expected: FAIL — `Cannot find module './sources.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/sources.ts
import { execFileSync } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";

export interface AuditFile {
	path: string;
	content: string;
}
export type FileMode = "changed" | "full";
export type GitRunner = (args: readonly string[]) => string;

export const CODE_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
	".rb", ".java", ".cs", ".cpp", ".c", ".h", ".swift", ".kt",
]);

export function hasCodeExtension(p: string): boolean {
	const dot = p.lastIndexOf(".");
	return dot !== -1 && CODE_EXTENSIONS.has(p.slice(dot));
}

function defaultGitRunner(cwd: string): GitRunner {
	return (args) =>
		execFileSync("git", [...args], { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}

function defaultBranch(runGit: GitRunner): string {
	// Resolve origin/HEAD → e.g. "origin/main"; fall back to "main".
	try {
		const ref = runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
		const name = ref.split("/").pop();
		if (name) return name;
	} catch {
		// origin/HEAD not set; fall through
	}
	return "main";
}

function changedPaths(runGit: GitRunner): string[] {
	const base = defaultBranch(runGit);
	const mergeBase = runGit(["merge-base", "HEAD", base]).trim() || base;
	const committed = runGit(["diff", "--name-only", mergeBase])
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	// porcelain lines look like " M path", "?? path", "A  path"
	const working = runGit(["status", "--porcelain"])
		.split("\n")
		.map((l) => l.slice(3).trim())
		.filter(Boolean);
	return [...committed, ...working];
}

export async function collectFilesFromLocal(opts: {
	cwd: string;
	mode: FileMode;
	runGit?: GitRunner;
	readFile?: (p: string) => Promise<string>;
}): Promise<AuditFile[]> {
	const runGit = opts.runGit ?? defaultGitRunner(opts.cwd);
	const readFile =
		opts.readFile ?? ((p: string) => fsReadFile(path.join(opts.cwd, p), "utf-8"));

	const raw =
		opts.mode === "full"
			? runGit(["ls-files"]).split("\n").map((l) => l.trim())
			: changedPaths(runGit);

	const unique = [...new Set(raw.filter(Boolean))].filter(hasCodeExtension).sort();

	const files: AuditFile[] = [];
	for (const p of unique) {
		try {
			files.push({ path: p, content: await readFile(p) });
		} catch {
			// deleted, unreadable, or binary — skip
		}
	}
	return files;
}
```

- [ ] **Step 4: Remove the duplicated constants from `audit.ts`**

In `src/audit.ts`, delete the `CODE_EXTENSIONS` set ([src/audit.ts:11-29](../../../src/audit.ts#L11-L29)) and the `hasCodeExtension` function ([src/audit.ts:31-34](../../../src/audit.ts#L31-L34)). Add to the imports at the top:

```typescript
import { type AuditFile, hasCodeExtension } from "./sources.js";
```

Replace the inline `Array<{ path: string; content: string }>` type used for `files` in `auditRepo` with `AuditFile[]`.

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/sources.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (audit.ts now imports from sources.ts).

- [ ] **Step 6: Commit**

```bash
git add src/sources.ts src/sources.test.ts src/audit.ts
git commit -m "feat(audit): local working-tree file collection (sources.ts)"
```

---

## Task 2: Extract `runAuditPass()` (single-provider audit core)

**Files:**
- Modify: `src/audit.ts`
- Test: `src/audit.test.ts`

`auditRepo` currently inlines: batch files (≤150 KB), run `TIER1_SKILLS` per batch via `runAgent`, collect + `mergeReviews` ([src/audit.ts:124-187](../../../src/audit.ts#L124-L187)). Extract that into a reusable function so both the remote and local orchestrators call it.

- [ ] **Step 1: Write the failing test**

```typescript
// src/audit.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("./review.js", async (orig) => {
	const actual = await orig<typeof import("./review.js")>();
	return { ...actual, runAgent: vi.fn() };
});
vi.mock("./prompt.js", () => ({
	buildAuditUserMessage: vi.fn(() => "USER_MSG"),
	buildAgentSystemPrompt: vi.fn(() => "SYS"),
	buildUserMessage: vi.fn(() => "U"),
}));

import { runAuditPass } from "./audit.js";
import { runAgent, TIER1_SKILLS } from "./review.js";
import { buildModelReview } from "./testing.js";
import type { ModelSelection } from "./router.js";

const selection: ModelSelection = { model: "test-model", tier: 1 } as ModelSelection;

describe("runAuditPass", () => {
	it("runs every Tier-1 skill and merges into one ModelReview", async () => {
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({
				event: "COMMENT",
				general_findings: [{ title: "F", body: "b", severity: "low" }],
				inline_comments: [],
			}),
			usage: { promptTokens: 1, completionTokens: 1 },
		});

		const merged = await runAuditPass({
			files: [{ path: "a.ts", content: "x" }],
			selection,
			extraInstructions: "",
			meta: { owner: "o", repo: "r", ref: "local" },
		});

		expect(runAgent).toHaveBeenCalledTimes(TIER1_SKILLS.length);
		expect(merged.general_findings).toHaveLength(1); // deduped by title
	});

	it("returns empty review when every agent fails", async () => {
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		const merged = await runAuditPass({
			files: [{ path: "a.ts", content: "x" }],
			selection,
			extraInstructions: "",
			meta: { owner: "o", repo: "r", ref: "local" },
		});
		expect(merged.general_findings).toHaveLength(0);
		expect(merged.inline_comments).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/audit.test.ts`
Expected: FAIL — `runAuditPass` is not exported.

- [ ] **Step 3: Implement `runAuditPass` in `src/audit.ts`**

Add the import of `ModelReview`/`mergeReviews`/`runAgent`/`TIER1_SKILLS` (already imported) and `AuditFile`. Add:

```typescript
const BATCH_BYTES = 150 * 1024;

function batchFiles(files: AuditFile[]): AuditFile[][] {
	const batches: AuditFile[][] = [];
	let current: AuditFile[] = [];
	let bytes = 0;
	for (const f of files) {
		if (bytes + f.content.length > BATCH_BYTES && current.length > 0) {
			batches.push(current);
			current = [f];
			bytes = f.content.length;
		} else {
			current.push(f);
			bytes += f.content.length;
		}
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

export async function runAuditPass(opts: {
	files: AuditFile[];
	selection: ModelSelection;
	extraInstructions: string;
	meta: { owner: string; repo: string; ref: string };
}): Promise<ModelReview> {
	const { files, selection, extraInstructions, meta } = opts;
	const reviews: ModelReview[] = [];

	for (const batch of batchFiles(files)) {
		const userMessage = buildAuditUserMessage({
			owner: meta.owner,
			repo: meta.repo,
			ref: meta.ref,
			extraInstructions,
			files: batch,
		});
		const settled = await Promise.allSettled(
			TIER1_SKILLS.map((skill) =>
				runAgent(skill, userMessage, selection, extraInstructions),
			),
		);
		for (const r of settled) {
			if (r.status === "fulfilled" && r.value) reviews.push(r.value.review);
		}
	}

	if (reviews.length === 0) {
		return { event: "COMMENT", general_findings: [], inline_comments: [] };
	}
	return mergeReviews(reviews);
}
```

Import `ModelSelection` from `./router.js` if not present, and `ModelReview`/`mergeReviews` are already exported by `./review.js`.

- [ ] **Step 4: Refactor `auditRepo` to call `runAuditPass`**

In `auditRepo`, replace the inline batch/agent/merge block ([src/audit.ts:124-187](../../../src/audit.ts#L124-L187)) with:

```typescript
const merged = await runAuditPass({
	files,
	selection,
	extraInstructions,
	meta: { owner, repo, ref },
});
if (merged.general_findings.length === 0 && merged.inline_comments.length === 0) {
	console.log("No findings.");
	return;
}
```

(Keep the existing `selection = routeModel(...)`, `formatAuditIssue`, dry-run, and issue-creation code below it.)

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/audit.test.ts && npm run test`
Expected: PASS; full suite still green (auditRepo behavior unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/audit.ts src/audit.test.ts
git commit -m "refactor(audit): extract runAuditPass from auditRepo"
```

---

## Task 3: Artifact writer (`writeArtifacts` + `formatAuditJson`)

**Files:**
- Modify: `src/audit.ts`
- Test: `src/audit.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/audit.test.ts
import { formatAuditJson } from "./audit.js";

describe("formatAuditJson", () => {
	it("emits untruncated {meta, review} with full inline bodies", () => {
		const longBody = "x".repeat(500);
		const review = buildModelReview({
			event: "REQUEST_CHANGES",
			general_findings: [],
			inline_comments: [
				{ title: "T", body: longBody, path: "a.ts", line: 3, start_line: null, suggestion: null },
			],
		});
		const json = JSON.parse(
			formatAuditJson({
				review,
				meta: { owner: "o", repo: "r", ref: "local", provider: "anthropic", model: "m", fileCount: 1 },
			}),
		);
		expect(json.meta.provider).toBe("anthropic");
		expect(json.review.inline_comments[0].body).toHaveLength(500); // untruncated
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/audit.test.ts -t formatAuditJson`
Expected: FAIL — `formatAuditJson` not exported.

- [ ] **Step 3: Implement in `src/audit.ts`**

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AuditMeta {
	owner: string;
	repo: string;
	ref: string;
	provider: "anthropic" | "openai";
	model: string;
	fileCount: number;
	pr?: number;
}

export function formatAuditJson(opts: { review: ModelReview; meta: AuditMeta }): string {
	return JSON.stringify({ meta: opts.meta, review: opts.review }, null, 2);
}

export async function writeArtifacts(opts: {
	outDir: string;
	perProvider: Array<{ review: ModelReview; meta: AuditMeta }>;
	markdown: string;
}): Promise<string[]> {
	await mkdir(opts.outDir, { recursive: true });
	const written: string[] = [];
	for (const entry of opts.perProvider) {
		const file = path.join(opts.outDir, `audit-${entry.meta.provider}.json`);
		await writeFile(file, formatAuditJson(entry), "utf-8");
		written.push(file);
	}
	const md = path.join(opts.outDir, "audit.md");
	await writeFile(md, opts.markdown, "utf-8");
	written.push(md);
	return written;
}
```

Reuse the existing `formatAuditIssue` for the combined markdown (rename-free; it already renders findings + an inline table). For the artifact, pass the merged-across-providers review (built in Task 4).

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/audit.test.ts -t formatAuditJson`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts src/audit.test.ts
git commit -m "feat(audit): structured JSON/MD artifact writer"
```

---

## Task 4: `runLocalAudit` orchestrator (both providers, dry-run path)

**Files:**
- Modify: `src/audit.ts`
- Test: `src/audit.test.ts` (append)

This runs both provider passes, writes artifacts, and (when not dry-run) hands the per-provider reviews to the PR layer (Task 8). In this task implement the dry-run path only; the PR call is added in Task 8.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/audit.test.ts
import { runLocalAudit } from "./audit.js";
import * as sources from "./sources.js";

describe("runLocalAudit (dry-run)", () => {
	it("runs both providers and writes one artifact per provider", async () => {
		vi.spyOn(sources, "collectFilesFromLocal").mockResolvedValue([{ path: "a.ts", content: "x" }]);
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({ event: "COMMENT", general_findings: [], inline_comments: [] }),
			usage: { promptTokens: 1, completionTokens: 1 },
		});
		const writeSpy = vi.spyOn(await import("node:fs/promises"), "writeFile").mockResolvedValue();
		vi.spyOn(await import("node:fs/promises"), "mkdir").mockResolvedValue(undefined as never);

		const result = await runLocalAudit({ cwd: "/repo", mode: "changed", outDir: ".ai-review", dryRun: true });

		expect(result.providers.map((p) => p.provider).sort()).toEqual(["anthropic", "openai"]);
		expect(writeSpy).toHaveBeenCalled(); // audit-anthropic.json, audit-openai.json, audit.md
		expect(result.pr).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/audit.test.ts -t runLocalAudit`
Expected: FAIL — `runLocalAudit` not exported.

- [ ] **Step 3: Implement in `src/audit.ts`**

```typescript
import { collectFilesFromLocal, type FileMode } from "./sources.js";
import { routeModel } from "./router.js";

const PROVIDERS = ["anthropic", "openai"] as const;

export interface LocalAuditResult {
	providers: Array<{ provider: "anthropic" | "openai"; review: ModelReview }>;
	artifacts: string[];
	pr?: number;
	url?: string;
}

export async function runLocalAudit(opts: {
	cwd: string;
	mode: FileMode;
	outDir: string;
	dryRun: boolean;
	extraInstructions?: string;
}): Promise<LocalAuditResult> {
	const files = await collectFilesFromLocal({ cwd: opts.cwd, mode: opts.mode });
	const filePaths = files.map((f) => f.path);
	const meta = { owner: "local", repo: "local", ref: "working-tree" };
	const extraInstructions = opts.extraInstructions ?? "";

	const providers: LocalAuditResult["providers"] = [];
	const perProvider: Array<{ review: ModelReview; meta: AuditMeta }> = [];

	for (const provider of PROVIDERS) {
		const selection = routeModel(
			{ additions: 0, deletions: 0, filePaths, labels: [] },
			provider,
		);
		const review = await runAuditPass({ files, selection, extraInstructions, meta });
		providers.push({ provider, review });
		perProvider.push({
			review,
			meta: { ...meta, provider, model: selection.model, fileCount: files.length },
		});
	}

	const combined = mergeReviews(providers.map((p) => p.review));
	const markdown = formatAuditIssue({
		merged: combined,
		owner: meta.owner,
		repo: meta.repo,
		ref: meta.ref,
		date: new Date().toISOString().slice(0, 10),
		fileCount: files.length,
	});
	const artifacts = await writeArtifacts({ outDir: opts.outDir, perProvider, markdown });

	if (opts.dryRun) {
		return { providers, artifacts };
	}
	// PR path added in Task 8.
	throw new Error("PR path not yet implemented");
}
```

> Note: `formatAuditIssue` is currently un-exported in `audit.ts`; no change needed since `runLocalAudit` is in the same module.

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/audit.test.ts -t runLocalAudit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts src/audit.test.ts
git commit -m "feat(audit): runLocalAudit two-provider orchestrator (dry-run)"
```

---

## Task 5: `ensureOrphanBase` + `createHeadBranch` (`src/audit-pr.ts`)

**Files:**
- Create: `src/audit-pr.ts`
- Test: `src/audit-pr.test.ts`

Uses the loose `OctokitLike` request shape already used in `review.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/audit-pr.test.ts
import { describe, expect, it, vi } from "vitest";
import { ensureOrphanBase } from "./audit-pr.js";

function octokitWith(handlers: Record<string, (params: unknown) => unknown>) {
	return {
		request: vi.fn(async (route: string, params: unknown) => {
			const h = handlers[route];
			if (!h) throw Object.assign(new Error("not found"), { status: 404 });
			return { data: h(params) };
		}),
	};
}

describe("ensureOrphanBase", () => {
	it("creates the orphan branch when missing", async () => {
		const created: string[] = [];
		const octokit = octokitWith({
			"GET /repos/{owner}/{repo}/git/ref/{ref}": () => {
				throw Object.assign(new Error("no ref"), { status: 404 });
			},
			"POST /repos/{owner}/{repo}/git/blobs": () => ({ sha: "BLOB" }),
			"POST /repos/{owner}/{repo}/git/trees": () => ({ sha: "TREE" }),
			"POST /repos/{owner}/{repo}/git/commits": () => ({ sha: "COMMIT" }),
			"POST /repos/{owner}/{repo}/git/refs": (p) => {
				created.push((p as { ref: string }).ref);
				return { ref: (p as { ref: string }).ref };
			},
		});
		await ensureOrphanBase(octokit as never, "o", "r", "ai-review/empty");
		expect(created).toEqual(["refs/heads/ai-review/empty"]);
	});

	it("is a no-op when the orphan branch already exists", async () => {
		const octokit = octokitWith({
			"GET /repos/{owner}/{repo}/git/ref/{ref}": () => ({ object: { sha: "X" } }),
		});
		await ensureOrphanBase(octokit as never, "o", "r", "ai-review/empty");
		expect(octokit.request).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/audit-pr.test.ts`
Expected: FAIL — `Cannot find module './audit-pr.js'`

- [ ] **Step 3: Implement `ensureOrphanBase` + `createHeadBranch`**

```typescript
// src/audit-pr.ts
import type { AuditFile } from "./sources.js";

export type OctokitLike = {
	request: <T>(route: string, params: Record<string, unknown>) => Promise<{ data: T }>;
};

function isStatus(err: unknown, code: number): boolean {
	return typeof err === "object" && err !== null && (err as { status?: number }).status === code;
}

export async function ensureOrphanBase(
	octokit: OctokitLike,
	owner: string,
	repo: string,
	branch: string,
): Promise<void> {
	try {
		await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
			owner, repo, ref: `heads/${branch}`,
		});
		return; // already exists
	} catch (err) {
		if (!isStatus(err, 404)) throw err;
	}
	// Empty tree → root commit with no parents → orphan ref.
	const { data: tree } = await octokit.request<{ sha: string }>(
		"POST /repos/{owner}/{repo}/git/trees", { owner, repo, tree: [] },
	);
	const { data: commit } = await octokit.request<{ sha: string }>(
		"POST /repos/{owner}/{repo}/git/commits",
		{ owner, repo, message: "ai-review: empty base", tree: tree.sha, parents: [] },
	);
	await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
		owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha,
	});
}

export async function createHeadBranch(opts: {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	branch: string;
	baseBranch: string;
	files: AuditFile[];
}): Promise<void> {
	const { octokit, owner, repo, branch, baseBranch, files } = opts;
	const { data: baseRef } = await octokit.request<{ object: { sha: string } }>(
		"GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: `heads/${baseBranch}` },
	);
	const baseSha = baseRef.object.sha;
	const { data: baseCommit } = await octokit.request<{ tree: { sha: string } }>(
		"GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: baseSha },
	);
	const tree = files.map((f) => ({
		path: f.path, mode: "100644" as const, type: "blob" as const, content: f.content,
	}));
	const { data: newTree } = await octokit.request<{ sha: string }>(
		"POST /repos/{owner}/{repo}/git/trees",
		{ owner, repo, base_tree: baseCommit.tree.sha, tree },
	);
	const { data: commit } = await octokit.request<{ sha: string }>(
		"POST /repos/{owner}/{repo}/git/commits",
		{ owner, repo, message: "ai-review: audit snapshot", tree: newTree.sha, parents: [baseSha] },
	);
	await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
		owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha,
	});
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/audit-pr.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audit-pr.ts src/audit-pr.test.ts
git commit -m "feat(audit-pr): orphan base + head branch creation"
```

---

## Task 6: `openDraftPr` (+ `AI audit` label) and `postProviderReview`

**Files:**
- Modify: `src/audit-pr.ts`
- Test: `src/audit-pr.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/audit-pr.test.ts
import { openDraftPr, postProviderReview } from "./audit-pr.js";
import { buildModelReview, buildPullFile } from "./testing.js";

describe("openDraftPr", () => {
	it("opens a draft PR and applies the AI audit label", async () => {
		const labels: string[] = [];
		const octokit = octokitWith({
			"POST /repos/{owner}/{repo}/pulls": () => ({ number: 42, html_url: "URL" }),
			"POST /repos/{owner}/{repo}/issues/{issue_number}/labels": (p) => {
				labels.push(...(p as { labels: string[] }).labels);
				return [];
			},
		});
		const out = await openDraftPr({
			octokit: octokit as never, owner: "o", repo: "r",
			head: "ai-review/audit-1", base: "ai-review/empty", title: "AI audit",
		});
		expect(out).toEqual({ number: 42, url: "URL" });
		expect(labels).toEqual(["AI audit"]);
	});
});

describe("postProviderReview", () => {
	it("submits inline comments validated against the orphan (full-file) diff", async () => {
		let submitted: { event: string; comments: unknown[] } | undefined;
		const octokit = octokitWith({
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": (p) => {
				submitted = p as never;
				return { id: 1 };
			},
		});
		// Orphan diff: file fully added → every line valid.
		const files = [buildPullFile("a.ts", "@@ -0,0 +1,3 @@\n+l1\n+l2\n+l3")];
		const review = buildModelReview({
			event: "REQUEST_CHANGES",
			general_findings: [],
			inline_comments: [
				{ title: "T", body: "b", path: "a.ts", line: 2, start_line: null, suggestion: null },
			],
		});
		await postProviderReview({
			octokit: octokit as never, owner: "o", repo: "r", pullNumber: 42,
			headSha: "SHA", files, review, prefix: "ai-review-bot",
		});
		expect(submitted?.event).toBe("REQUEST_CHANGES");
		expect(submitted?.comments).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/audit-pr.test.ts -t "openDraftPr|postProviderReview"`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement in `src/audit-pr.ts`**

```typescript
import { buildReviewComments, type ModelReview } from "./review.js";

const AI_AUDIT_LABEL = "AI audit";

export async function openDraftPr(opts: {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	head: string;
	base: string;
	title: string;
	body?: string;
}): Promise<{ number: number; url: string }> {
	const { octokit, owner, repo, head, base, title, body } = opts;
	const { data: pr } = await octokit.request<{ number: number; html_url: string }>(
		"POST /repos/{owner}/{repo}/pulls",
		{ owner, repo, head, base, title, body: body ?? "Automated AI audit.", draft: true },
	);
	await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
		owner, repo, issue_number: pr.number, labels: [AI_AUDIT_LABEL],
	});
	return { number: pr.number, url: pr.html_url };
}

interface PullFileLike {
	filename: string;
	status: string;
	patch?: string;
}

export async function postProviderReview(opts: {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	files: PullFileLike[];
	review: ModelReview;
	prefix: string;
}): Promise<void> {
	const { octokit, owner, repo, pullNumber, headSha, files, review, prefix } = opts;
	const comments = buildReviewComments(files, review.inline_comments);
	const event = review.event === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "COMMENT";
	const findingLines = review.general_findings.map((f) => `- **[${f.severity}] ${f.title}** — ${f.body}`);
	const body = [`### ${prefix}`, "", ...findingLines].join("\n");
	await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
		owner, repo, pull_number: pullNumber, commit_id: headSha, event, body, comments,
	});
}
```

> `buildReviewComments` (from `review.ts`) already extracts valid right-side lines from each file's `patch` and drops anchors outside the diff. Against the orphan diff every file's patch is a full-file addition, so all lines validate. Add the label name to the App's known labels if label auto-creation isn't enabled — GitHub auto-creates an unknown label on first use, so no pre-step is required.

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/audit-pr.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audit-pr.ts src/audit-pr.test.ts
git commit -m "feat(audit-pr): draft PR + AI audit label + two-identity review posting"
```

---

## Task 7: `makeReady` (retarget + un-draft)

**Files:**
- Modify: `src/audit-pr.ts`
- Test: `src/audit-pr.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/audit-pr.test.ts
import { makeReady } from "./audit-pr.js";

describe("makeReady", () => {
	it("retargets base to the default branch and marks ready", async () => {
		const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
		const octokit = {
			request: vi.fn(async (route: string, params: Record<string, unknown>) => {
				calls.push({ route, params });
				if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}")
					return { data: { node_id: "PR_NODE" } };
				return { data: {} };
			}),
		};
		await makeReady({ octokit: octokit as never, owner: "o", repo: "r", pullNumber: 42, base: "main" });
		const edit = calls.find((c) => c.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
		expect(edit?.params.base).toBe("main");
		// ready-for-review is a GraphQL mutation (REST has no toggle)
		expect(calls.some((c) => c.route === "POST /graphql")).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/audit-pr.test.ts -t makeReady`
Expected: FAIL — `makeReady` not exported.

- [ ] **Step 3: Implement in `src/audit-pr.ts`**

```typescript
export async function makeReady(opts: {
	octokit: OctokitLike;
	owner: string;
	repo: string;
	pullNumber: number;
	base: string;
}): Promise<void> {
	const { octokit, owner, repo, pullNumber, base } = opts;
	// 1. Retarget base → default branch (collapses the diff to fixes-only).
	await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
		owner, repo, pull_number: pullNumber, base,
	});
	// 2. Mark ready — REST has no draft toggle; use the GraphQL mutation.
	const { data: pr } = await octokit.request<{ node_id: string }>(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: pullNumber },
	);
	await octokit.request("POST /graphql", {
		query: "mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ clientMutationId } }",
		variables: { id: pr.node_id },
	});
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/audit-pr.test.ts -t makeReady`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audit-pr.ts src/audit-pr.test.ts
git commit -m "feat(audit-pr): makeReady retargets base + marks ready"
```

---

## Task 8: Wire the PR path into `runLocalAudit` (+ 403 fallback)

**Files:**
- Modify: `src/audit.ts`
- Test: `src/audit.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/audit.test.ts
vi.mock("./audit-pr.js", () => ({
	ensureOrphanBase: vi.fn(),
	createHeadBranch: vi.fn(),
	openDraftPr: vi.fn(async () => ({ number: 7, url: "U7" })),
	postProviderReview: vi.fn(),
	makeReady: vi.fn(),
}));

describe("runLocalAudit (PR path)", () => {
	it("opens a PR and returns its number/url when findings exist", async () => {
		vi.spyOn(sources, "collectFilesFromLocal").mockResolvedValue([{ path: "a.ts", content: "x" }]);
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({
				event: "REQUEST_CHANGES", general_findings: [],
				inline_comments: [{ title: "T", body: "b", path: "a.ts", line: 1, start_line: null, suggestion: null }],
			}),
			usage: { promptTokens: 1, completionTokens: 1 },
		});
		vi.spyOn(await import("node:fs/promises"), "writeFile").mockResolvedValue();
		vi.spyOn(await import("node:fs/promises"), "mkdir").mockResolvedValue(undefined as never);

		const result = await runLocalAudit({
			cwd: "/repo", mode: "changed", outDir: ".ai-review", dryRun: false,
			resolvePr: async () => ({ octokit: {} as never, owner: "o", repo: "r", baseBranch: "main", postAs: [{ provider: "anthropic", prefix: "ai-review-bot" }, { provider: "openai", prefix: "codex-review-bot" }] }),
		});
		expect(result.pr).toBe(7);
		expect(result.url).toBe("U7");
	});

	it("falls back to artifacts only when branch creation 403s", async () => {
		const auditPr = await import("./audit-pr.js");
		(auditPr.createHeadBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			Object.assign(new Error("no perms"), { status: 403 }),
		);
		vi.spyOn(sources, "collectFilesFromLocal").mockResolvedValue([{ path: "a.ts", content: "x" }]);
		(runAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
			review: buildModelReview({ event: "REQUEST_CHANGES", general_findings: [], inline_comments: [] }),
			usage: { promptTokens: 1, completionTokens: 1 },
		});
		vi.spyOn(await import("node:fs/promises"), "writeFile").mockResolvedValue();
		vi.spyOn(await import("node:fs/promises"), "mkdir").mockResolvedValue(undefined as never);

		const result = await runLocalAudit({
			cwd: "/repo", mode: "changed", outDir: ".ai-review", dryRun: false,
			resolvePr: async () => ({ octokit: {} as never, owner: "o", repo: "r", baseBranch: "main", postAs: [] }),
		});
		expect(result.pr).toBeUndefined(); // degraded; artifacts still written
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/audit.test.ts -t "PR path"`
Expected: FAIL — `resolvePr` / PR wiring not implemented.

- [ ] **Step 3: Implement the PR path in `runLocalAudit`**

Replace the `throw new Error("PR path not yet implemented")` with:

```typescript
import {
	createHeadBranch, ensureOrphanBase, makeReady, openDraftPr, postProviderReview,
} from "./audit-pr.js";

// add to the opts type:
//   resolvePr?: () => Promise<{
//     octokit: OctokitLike; owner: string; repo: string; baseBranch: string;
//     postAs: Array<{ provider: "anthropic" | "openai"; prefix: string }>;
//   }>;

const hasFindings = combined.general_findings.length > 0 || combined.inline_comments.length > 0;
if (!hasFindings || !opts.resolvePr) {
	return { providers, artifacts };
}

const ctx = await opts.resolvePr();
const ORPHAN = "ai-review/empty";
const head = `ai-review/audit-${Date.now()}`;
try {
	await ensureOrphanBase(ctx.octokit, ctx.owner, ctx.repo, ORPHAN);
	await createHeadBranch({
		octokit: ctx.octokit, owner: ctx.owner, repo: ctx.repo,
		branch: head, baseBranch: ctx.baseBranch, files,
	});
	const { number, url } = await openDraftPr({
		octokit: ctx.octokit, owner: ctx.owner, repo: ctx.repo,
		head, base: ORPHAN, title: `AI audit — ${new Date().toISOString().slice(0, 10)}`,
	});
	const headSha = await headShaFor(ctx.octokit, ctx.owner, ctx.repo, head);
	const pullFiles = files.map((f) => ({
		filename: f.path, status: "added",
		patch: `@@ -0,0 +1,${f.content.split("\n").length} @@\n${f.content.split("\n").map((l) => `+${l}`).join("\n")}`,
	}));
	for (const target of ctx.postAs) {
		const review = providers.find((p) => p.provider === target.provider)?.review;
		if (review) {
			await postProviderReview({
				octokit: ctx.octokit, owner: ctx.owner, repo: ctx.repo, pullNumber: number,
				headSha, files: pullFiles, review, prefix: target.prefix,
			});
		}
	}
	// persist meta.pr into the JSON artifacts
	for (const entry of perProvider) entry.meta.pr = number;
	await writeArtifacts({ outDir: opts.outDir, perProvider, markdown });
	return { providers, artifacts, pr: number, url };
} catch (err) {
	if ((err as { status?: number }).status === 403) {
		console.warn("contents:write not granted — PR path skipped; writing artifacts + issue fallback.");
		try {
			await createOrUpdateAuditIssue({ octokit: ctx.octokit, owner: ctx.owner, repo: ctx.repo, body: markdown });
		} catch {
			// best-effort: artifacts are already written regardless
		}
		return { providers, artifacts };
	}
	throw err;
}
```

Add two helpers:

```typescript
async function headShaFor(octokit: OctokitLike, owner: string, repo: string, branch: string): Promise<string> {
	const { data } = await octokit.request<{ object: { sha: string } }>(
		"GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: `heads/${branch}` },
	);
	return data.object.sha;
}

// Idempotent fallback: reuse the open "Code Audit Report" issue, else create one.
async function createOrUpdateAuditIssue(opts: {
	octokit: OctokitLike; owner: string; repo: string; body: string;
}): Promise<void> {
	const { octokit, owner, repo, body } = opts;
	const title = `Code Audit Report — ${new Date().toISOString().slice(0, 10)}`;
	const { data: open } = await octokit.request<Array<{ number: number; title: string }>>(
		"GET /repos/{owner}/{repo}/issues", { owner, repo, state: "open", labels: "AI audit" },
	);
	const existing = open.find((i) => i.title.startsWith("Code Audit Report"));
	if (existing) {
		await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
			owner, repo, issue_number: existing.number, body,
		});
	} else {
		await octokit.request("POST /repos/{owner}/{repo}/issues", {
			owner, repo, title, body, labels: ["AI audit"],
		});
	}
}
```

> The issue fallback uses `issues: write` (already granted — the apps create issues today), so it succeeds even when the `contents` 403 fires. It's wrapped in best-effort `try/catch` so a degraded run never throws.

Import `OctokitLike` from `./audit-pr.js`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/audit.test.ts && npm run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts src/audit.test.ts
git commit -m "feat(audit): wire synthetic-base PR path with 403 fallback"
```

---

## Task 9: CLI subcommands (`audit`, `ready`, legacy remote)

**Files:**
- Modify: `src/cli.ts`

`resolvePr` is built here (it needs both App identities). The Claude app posts as `ai-review-bot`; the Codex app posts as `codex-review-bot`. The PR is opened + branches created with the Claude installation octokit; each `postProviderReview` uses that provider's installation octokit so the review author identity matches.

- [ ] **Step 1: Restructure `main()` for subcommand dispatch**

Replace the body of `main()` in `src/cli.ts` so the first positional selects the subcommand:

```typescript
async function main(): Promise<void> {
	const [sub, ...rest] = process.argv.slice(2);

	if (sub === "audit") return cmdAudit(rest);
	if (sub === "ready") return cmdReady(rest);
	if (sub && sub.includes("/")) return cmdLegacyRemote([sub, ...rest]); // back-compat
	usage();
}
```

Move the existing remote logic (`createApp`, flag loop, `auditRepo`) into `cmdLegacyRemote(args)` unchanged.

- [ ] **Step 2: Implement `cmdAudit`**

```typescript
import { runLocalAudit } from "./audit.js";
import { getConfig, getOpenAIAppConfig } from "./config.js";
import { App } from "octokit";

async function cmdAudit(args: string[]): Promise<void> {
	let mode: "changed" | "full" = "changed";
	let dryRun = false;
	let outDir = ".ai-review";
	let extra = "";
	let json = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--full") mode = "full";
		else if (args[i] === "--dry-run") dryRun = true;
		else if (args[i] === "--out" && args[i + 1]) outDir = args[++i];
		else if (args[i] === "--extra" && args[i + 1]) extra = args[++i];
		else if (args[i] === "--json") json = true;
		else if (args[i].startsWith("--")) fatal(`Unknown flag: ${args[i]}`);
	}

	const result = await runLocalAudit({
		cwd: process.cwd(), mode, outDir, dryRun, extraInstructions: extra,
		resolvePr: dryRun ? undefined : buildResolvePr,
	});

	if (json) {
		console.log(JSON.stringify({ pr: result.pr, url: result.url, artifacts: result.artifacts }));
	} else {
		console.log(`Artifacts: ${result.artifacts.join(", ")}`);
		if (result.url) console.log(`Review PR: ${result.url}`);
	}
}
```

- [ ] **Step 3: Implement `buildResolvePr` (both identities + repo from origin)**

```typescript
import { execFileSync } from "node:child_process";

function originSlug(): { owner: string; repo: string } {
	const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" }).trim();
	const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
	if (!m) fatal(`Cannot parse owner/repo from origin: ${url}`);
	return { owner: m[1], repo: m[2] };
}

async function installationOctokit(appId: string, privateKey: string, owner: string, repo: string) {
	const app = new App({ appId, privateKey: privateKey.replaceAll(String.raw`\n`, "\n") });
	const { data: inst } = await app.octokit.request(
		"GET /repos/{owner}/{repo}/installation", { owner, repo },
	);
	return app.getInstallationOctokit(inst.id);
}

async function buildResolvePr() {
	const { owner, repo } = originSlug();
	const claude = getConfig();
	const codex = getOpenAIAppConfig();
	const claudeKit = await installationOctokit(claude.appId, claude.privateKey, owner, repo);
	const codexKit = await installationOctokit(codex.appId, codex.privateKey, owner, repo);
	const { data: repoData } = await claudeKit.request("GET /repos/{owner}/{repo}", { owner, repo });

	// Each postProviderReview must run under the matching identity; runLocalAudit
	// uses ctx.octokit for branch/PR ops and looks up per-provider kits via postAs.
	return {
		octokit: claudeKit as never,
		owner, repo, baseBranch: repoData.default_branch,
		postAs: [
			{ provider: "anthropic" as const, prefix: claude.reviewCommentPrefix, octokit: claudeKit as never },
			{ provider: "openai" as const, prefix: codex.reviewCommentPrefix, octokit: codexKit as never },
		],
	};
}
```

> Update the `postAs` element type in `runLocalAudit` (Task 8) to carry an optional `octokit`, and in the posting loop use `target.octokit ?? ctx.octokit` for `postProviderReview`. This keeps each review's author identity correct.

- [ ] **Step 4: Implement `cmdReady`**

```typescript
import { readFile } from "node:fs/promises";
import { makeReady } from "./audit-pr.js";

async function cmdReady(args: string[]): Promise<void> {
	const positional = args.find((a) => !a.startsWith("--"));
	const { owner, repo } = originSlug();
	const claude = getConfig();
	const octokit = await installationOctokit(claude.appId, claude.privateKey, owner, repo);

	let pr = positional ? Number(positional) : undefined;
	if (!pr) {
		try {
			const meta = JSON.parse(await readFile(".ai-review/audit-anthropic.json", "utf-8"));
			pr = meta?.meta?.pr;
		} catch { /* no recorded PR */ }
	}
	if (!pr) fatal("No PR number given and none recorded in .ai-review/audit-anthropic.json");

	const { data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
	await makeReady({ octokit: octokit as never, owner, repo, pullNumber: pr, base: repoData.default_branch });
	console.log(`PR #${pr} retargeted to ${repoData.default_branch} and marked ready.`);
}
```

- [ ] **Step 5: Update usage text**

```typescript
function usage(): never {
	console.error("Usage:");
	console.error("  ai-review audit [--full] [--dry-run] [--out <dir>] [--extra <text>] [--json]");
	console.error("  ai-review ready [pr#]");
	console.error("  ai-review OWNER/REPO [...]      (legacy remote audit — deprecated)");
	process.exit(1);
}
```

- [ ] **Step 6: Verify typecheck + full suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/audit.ts
git commit -m "feat(cli): audit and ready subcommands with two-identity PR posting"
```

---

## Task 10: Ignore artifacts + docs

**Files:**
- Modify: `.gitignore`, `CLAUDE.md` (key files table / env section if needed)

- [ ] **Step 1: Add `.ai-review/` to `.gitignore`**

```
# AI Review local audit artifacts
.ai-review/
```

- [ ] **Step 2: Document the subcommands**

Add a short "Local audit" subsection to `CLAUDE.md` under the CLI entry pointing at `ai-review audit` / `ai-review ready` and the spec.

- [ ] **Step 3: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "chore: ignore .ai-review artifacts; document audit/ready"
```

---

## Phase 4 (deferred): Plugin command

The `AI Review:` plugin command that orchestrates `audit` → first-pass fix → `ready` → `/pr-loop` is designed in a separate pass (spec "Open items"). Not part of this plan.

---

## Manual verification (after Task 10)

Follow the spec's Verification section:
1. `ai-review audit --dry-run --out /tmp/aud` in a repo with an uncommitted bug → `audit-*.json` untruncated and reflects the change; `--full` differs from default.
2. Unset `GITHUB_APP_ID` → `audit --dry-run` still runs on AI keys alone.
3. With `contents: write` granted: `ai-review audit` → draft PR shows whole files as additions, `AI audit` label set, inline comments post; `ai-review ready` → diff collapses to fixes-only, merges clean.
4. Without the scope → 403 caught, artifacts written, degraded gracefully.
