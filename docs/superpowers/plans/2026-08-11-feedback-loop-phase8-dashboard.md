# Feedback Loop — Phase 8 Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `dashboard/` — a Joe-only, GitHub-OAuth-gated Next.js app, deployed as a **separate** Vercel project, that reads the Neon feedback-loop corpus (Phases 1–7) and mirrors `ai-review trends --json` / `ai-review propose --dry-run`, with a button to open a GitHub issue from a metric.

**Architecture:** `dashboard/` is an npm workspace member of this repo (workspace membership exists solely so one root `npm install` wires a shared `node_modules`; it deploys as its own Vercel project rooted at `dashboard/`, completely separate from the existing root `api/*.ts` webhook project). Dashboard code imports `src/improve/*` by relative filesystem path — never as a package — and `next.config.ts` sets `outputFileTracingRoot` so Vercel's function-bundle tracer doesn't tree-shake those files out. Auth is Auth.js v5 (`next-auth@beta`) with a GitHub OAuth App and a login allowlist. The "open issue from metric" action reuses `openProposalIssue` (already built in Phase 7) via a newly-extracted `installationOctokit` helper shared with the CLI and the weekly cron.

**Tech Stack:** Next.js (App Router, Node runtime), TypeScript, `next-auth@beta` (Auth.js v5), Drizzle/`pg` (via `src/improve/db/*`, reused), Vitest, Biome (root config, zero extra dashboard config).

**Reference spec:** `docs/superpowers/specs/2026-08-11-feedback-loop-phase8-dashboard-design.md` — read it first; this plan implements it task-by-task. Do not deviate from its architecture decisions (separate Vercel project, relative-path imports, `outputFileTracingRoot`) without going back to Joe.

---

## Before you start

- Confirm you're on a clean working tree at repo root (`ai-review-bot`), branch off `main`.
- Confirm `npm run typecheck && npm run lint && npm test` are green *before* touching anything — this is your baseline.
- This plan was verified against the actually-installed toolchain at plan-writing time: `create-next-app@latest` resolves to Next.js `16.3.0` / React `19.2.8`, and its real `--help` output was used for the scaffold flags below (not memorized flags — some `--no-x` forms are commander.js auto-negations of `--x` and aren't listed explicitly in `--help`, but they work). If `next`/`create-next-app` has moved to a new major version by the time you run this, re-check `npx create-next-app@latest --help` and adjust Task 2 Step 1 accordingly — don't blindly trust the flags below if the tool's own help text disagrees.

---

### Task 1: Extract `installationOctokit` (prep refactor, no behavior change)

`src/cli.ts` (its own local `installationOctokit`, lines ~135–149) and `api/cron/improve.ts` (inline `App` construction, lines ~7–38) each independently build an installation-authenticated Octokit with identical logic. Extract to a shared module before touching `dashboard/` — the dashboard's server action needs this same helper, and duplicating it a third time would make four copies instead of fixing the existing two.

**Files:**
- Create: `src/improve/octokit.ts`
- Create: `src/improve/octokit.test.ts`
- Modify: `src/cli.ts`
- Modify: `api/cron/improve.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/improve/octokit.test.ts
import { describe, expect, it, vi } from "vitest";

const requestMock = vi.fn();
const getInstallationOctokitMock = vi.fn();
const AppCtor = vi.fn().mockImplementation(() => ({
	octokit: { request: requestMock },
	getInstallationOctokit: getInstallationOctokitMock,
}));

vi.mock("octokit", () => ({ App: AppCtor }));

const { installationOctokit } = await import("./octokit.js");

describe("installationOctokit", () => {
	it("resolves the installation id then returns its Octokit", async () => {
		requestMock.mockResolvedValue({ data: { id: 42 } });
		getInstallationOctokitMock.mockResolvedValue({ marker: "installation-octokit" });

		const result = await installationOctokit("app-1", "-----BEGIN...", "owner", "repo");

		expect(requestMock).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/installation",
			{ owner: "owner", repo: "repo" },
		);
		expect(getInstallationOctokitMock).toHaveBeenCalledWith(42);
		expect(result).toEqual({ marker: "installation-octokit" });
	});

	it("normalizes escaped \\n sequences in the private key", async () => {
		requestMock.mockResolvedValue({ data: { id: 1 } });
		getInstallationOctokitMock.mockResolvedValue({});

		await installationOctokit("app-1", String.raw`line1\nline2`, "owner", "repo");

		expect(AppCtor).toHaveBeenCalledWith({
			appId: "app-1",
			privateKey: "line1\nline2",
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/improve/octokit.test.ts`
Expected: FAIL — `Cannot find module './octokit.js'` (or equivalent resolve error), since `src/improve/octokit.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/improve/octokit.ts
import { App } from "octokit";

/** Build an Octokit authenticated as one GitHub App's installation on a repo.
 * Shared by the CLI (`ai-review propose`/`ready`/`backfill`), the weekly cron
 * (`api/cron/improve.ts`), and the dashboard's "open issue from metric" action. */
export async function installationOctokit(
	appId: string,
	privateKey: string,
	owner: string,
	repo: string,
) {
	const app = new App({
		appId,
		privateKey: privateKey.replaceAll(String.raw`\n`, "\n"),
	});
	const { data: inst } = await app.octokit.request(
		"GET /repos/{owner}/{repo}/installation",
		{ owner, repo },
	);
	return app.getInstallationOctokit(inst.id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/improve/octokit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Update `src/cli.ts` to use the shared helper**

Remove the local `installationOctokit` function (currently at `src/cli.ts:135-149`, immediately after `originSlug()`):

```ts
async function installationOctokit(
	appId: string,
	privateKey: string,
	owner: string,
	repo: string,
) {
	const app = new App({
		appId,
		privateKey: privateKey.replaceAll(String.raw`\n`, "\n"),
	});
	const { data: inst } = await app.octokit.request(
		"GET /repos/{owner}/{repo}/installation",
		{ owner, repo },
	);
	return app.getInstallationOctokit(inst.id);
}
```

Add an import for it instead, inserted alphabetically among the existing `./improve/*` imports (after the `./improve/match.js` import, before `./improve/trends.js`):

```ts
import { fpSignature } from "./improve/match.js";
import { installationOctokit } from "./improve/octokit.js";
import {
	computeSeverityReliability,
	computeSkillSignals,
	detectDuplicateClusters,
} from "./improve/trends.js";
```

Leave the `App` import from `"octokit"` in place — `createApp()` (around `src/cli.ts:107`) still uses it directly for an unrelated purpose.

- [ ] **Step 6: Update `api/cron/improve.ts` to use the shared helper**

Replace:

```ts
import { App } from "octokit";
import { getConfig } from "../../src/config.js";
```

with:

```ts
import { getConfig } from "../../src/config.js";
import { installationOctokit } from "../../src/improve/octokit.js";
```

And replace the inline construction inside the `run:` callback:

```ts
			const config = getConfig();
			const app = new App({
				appId: config.appId,
				privateKey: config.privateKey.replaceAll(String.raw`\n`, "\n"),
			});
			const { data: inst } = await app.octokit.request(
				"GET /repos/{owner}/{repo}/installation",
				{ owner, repo },
			);
			const octokit = (await app.getInstallationOctokit(
				inst.id,
			)) as unknown as IssueOctokit;
```

with:

```ts
			const config = getConfig();
			const octokit = (await installationOctokit(
				config.appId,
				config.privateKey,
				owner,
				repo,
			)) as unknown as IssueOctokit;
```

`config.privateKey` has already been through `normalizePrivateKey()` inside `getConfig()` (see `src/config.ts:113-115`), so it arrives with real newlines already; `installationOctokit`'s own `.replaceAll` is then a no-op on it — same behavior as before, just deduplicated. There is no test file for `api/cron/improve.ts` today, so there's nothing to update there.

- [ ] **Step 7: Confirm root gates are still green**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all pass, no new failures. `npm run lint -- --write` if Biome flags import ordering.

- [ ] **Step 8: Commit**

```bash
git add src/improve/octokit.ts src/improve/octokit.test.ts src/cli.ts api/cron/improve.ts
git commit -m "refactor(improve): extract installationOctokit shared by cli, cron, and dashboard"
```

---

### Task 2: Scaffold `dashboard/` as an npm workspace member

**Files:**
- Create: `dashboard/` (via `create-next-app`, then trimmed)
- Modify: `package.json` (root — add `workspaces`)

- [ ] **Step 1: Scaffold with `create-next-app`, skipping install**

Run from repo root:

```bash
npx create-next-app@latest dashboard --ts --no-eslint --no-tailwind --app --no-src-dir --import-alias "@/*" --use-npm --skip-install --disable-git --no-agents-md
```

`--skip-install` means no `dashboard/package-lock.json` is ever created — npm workspaces doesn't support a member having its own lockfile, so this sidesteps that footgun by never generating one, rather than generating-then-deleting it.

This produces `dashboard/app/{layout.tsx,page.tsx,page.module.css,globals.css,favicon.ico}`, `dashboard/public/*.svg`, `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/next.config.ts`, `dashboard/next-env.d.ts`, `dashboard/.gitignore`, `dashboard/README.md`.

- [ ] **Step 2: Delete the placeholder assets and README you won't use**

```bash
rm dashboard/app/page.module.css dashboard/public/file.svg dashboard/public/globe.svg dashboard/public/next.svg dashboard/public/vercel.svg dashboard/public/window.svg dashboard/README.md
```

(You'll overwrite `dashboard/app/page.tsx` and `dashboard/app/layout.tsx` in Task 6, so leave those as scaffolded for now.)

- [ ] **Step 3: Wire the npm workspace at repo root**

In `package.json`, add a `"workspaces"` field. Insert it right after `"author"` and before `"keywords"`:

```json
	"author": "Joe Black <joeblackwaslike@gmail.com>",
	"workspaces": ["dashboard"],
	"keywords": [
```

- [ ] **Step 4: Install from repo root**

```bash
npm install
```

This creates one shared `node_modules/` at repo root with `node_modules/dashboard` symlinked to `dashboard/`, and installs `next`/`react`/`react-dom` (dashboard's current dependencies) into it. No `dashboard/node_modules` should be created.

- [ ] **Step 5: Add `outputFileTracingRoot` to `dashboard/next.config.ts`**

```ts
// dashboard/next.config.ts
import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	outputFileTracingRoot: path.join(__dirname, ".."),
};

export default nextConfig;
```

Without this, Vercel's file tracer (`@vercel/nft`) can tree-shake `src/improve/**` out of the deployed function bundle even though `next build` succeeds locally — this only surfaces as a prod 404/500 after deploy, so setting it now (before any code depends on it) avoids forgetting it later. (Local `next build` will not catch a missing/wrong value here — see Task 9's Verification section for the check that does.)

- [ ] **Step 6: Smoke-test the scaffold builds as a workspace member**

```bash
npm run build --workspace=dashboard
```

Expected: succeeds using the stock scaffolded page. This proves the workspace/build machinery is wired correctly before Tasks 3–8 layer real code on top of it — it does *not* prove `outputFileTracingRoot` is correct (that can only be confirmed by an actual Vercel deploy, per Task 9).

- [ ] **Step 7: Commit**

```bash
git add dashboard package.json package-lock.json
git commit -m "chore(dashboard): scaffold Next.js app as an npm workspace member"
```

---

### Task 3: Allowlist logic (TDD) + dashboard test runner

**Files:**
- Create: `dashboard/lib/allowlist.ts`
- Create: `dashboard/lib/allowlist.test.ts`
- Create: `dashboard/vitest.config.ts`
- Modify: `dashboard/package.json` (scripts + `vitest` devDependency)
- Modify: `.github/workflows/ci.yml` (add dashboard-scoped typecheck/test)

**Added during execution (code review finding on Task 2):** CI (`.github/workflows/ci.yml`) runs root `npm run typecheck`/`npm test`, which are structurally scoped away from `dashboard/**` (root `tsconfig.json`'s `include` and `vitest.config.ts`'s `include` both exclude it). Once this task gives `dashboard/package.json` its own `typecheck`/`test` scripts (Step 1 below), CI must also run them — otherwise every later task (4 through 9) can ship type errors or failing tests in `dashboard/` that CI is structurally blind to. Add this as the task's final step, after Step 7:

- [ ] **Step 8: Wire `dashboard/` into CI**

Edit `.github/workflows/ci.yml`, adding two steps after the existing `Test` step:

```yaml
      - name: Test
        run: npm test

      - name: Typecheck (dashboard)
        run: npm run typecheck --workspace=dashboard

      - name: Test (dashboard)
        run: npm run test --workspace=dashboard
```

Run `git diff .github/workflows/ci.yml` to confirm only these two steps were added, then commit this alongside the rest of Task 3 (fold into the same commit — don't create a separate one for a two-line CI change tied directly to this task's `package.json` edits).

- [ ] **Step 1: Add the dashboard's own test/typecheck scripts and `vitest`**

```bash
npm install -D vitest --workspace=dashboard
```

Edit `dashboard/package.json`'s `"scripts"` to add:

```json
	"scripts": {
		"dev": "next dev",
		"build": "next build",
		"start": "next start",
		"typecheck": "tsc --noEmit",
		"test": "vitest run"
	},
```

- [ ] **Step 2: Add `dashboard/vitest.config.ts`**

```ts
// dashboard/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["**/*.test.ts"],
		exclude: ["node_modules/**", ".next/**"],
	},
});
```

- [ ] **Step 3: Write the failing test**

```ts
// dashboard/lib/allowlist.test.ts
import { describe, expect, it } from "vitest";
import { isAllowedLogin, parseAllowlist } from "./allowlist.js";

describe("parseAllowlist", () => {
	it("splits, trims, and lowercases comma-separated logins", () => {
		expect(parseAllowlist(" Joeblackwaslike , other-user ")).toEqual([
			"joeblackwaslike",
			"other-user",
		]);
	});

	it("returns an empty array for undefined or blank input", () => {
		expect(parseAllowlist(undefined)).toEqual([]);
		expect(parseAllowlist("")).toEqual([]);
		expect(parseAllowlist(" , , ")).toEqual([]);
	});
});

describe("isAllowedLogin", () => {
	const allowlist = ["joeblackwaslike"];

	it("admits a login on the allowlist, case-insensitively", () => {
		expect(isAllowedLogin("JoeBlackWasLike", allowlist)).toBe(true);
	});

	it("rejects a login not on the allowlist", () => {
		expect(isAllowedLogin("someone-else", allowlist)).toBe(false);
	});

	it("rejects a null or undefined login", () => {
		expect(isAllowedLogin(null, allowlist)).toBe(false);
		expect(isAllowedLogin(undefined, allowlist)).toBe(false);
	});
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run test --workspace=dashboard`
Expected: FAIL — `dashboard/lib/allowlist.ts` doesn't exist yet.

- [ ] **Step 5: Write the implementation**

```ts
// dashboard/lib/allowlist.ts
export function parseAllowlist(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

export function isAllowedLogin(
	login: string | null | undefined,
	allowlist: string[],
): boolean {
	if (!login) return false;
	return allowlist.includes(login.toLowerCase());
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test --workspace=dashboard`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/allowlist.ts dashboard/lib/allowlist.test.ts dashboard/vitest.config.ts dashboard/package.json package-lock.json
git commit -m "feat(dashboard): login allowlist parsing"
```

---

### Task 4: Auth — Auth.js v5, GitHub OAuth, allowlist gate

**Files:**
- Create: `dashboard/auth.ts`
- Create: `dashboard/app/api/auth/[...nextauth]/route.ts`
- Create: `dashboard/middleware.ts`

- [ ] **Step 1: Install and pin `next-auth`**

```bash
npm install --save-exact next-auth@beta --workspace=dashboard
```

`--save-exact` matters here: Auth.js v5 is still beta-only and has shipped breaking changes between betas (per the design spec's Risks section), so this must not float on a caret range. Confirm `dashboard/package.json` now shows an exact version (no `^`/`~` prefix) for `"next-auth"`.

Before writing the files below, check that the installed version's docs still document the same middleware/route-handler/server-action shape used here — run `cat node_modules/next-auth/package.json | grep '"version"'` to get the exact version, then look it up (Context7 `resolve-library-id`/`query-docs` for `next-auth`, or fetch the versioned Auth.js migration guide) before proceeding, since the code below is the pattern documented as of plan-writing time and betas do drift.

- [ ] **Step 2: Write `dashboard/auth.ts`**

Imports nothing from `src/improve/db/*` — this file loads in `middleware.ts`, which runs on the Edge runtime, so it must stay free of Node-only dependencies (`pg`, etc.).

```ts
// dashboard/auth.ts
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { isAllowedLogin, parseAllowlist } from "./lib/allowlist.js";

const allowlist = parseAllowlist(process.env.DASHBOARD_ALLOWED_LOGIN);

export const { handlers, auth, signIn, signOut } = NextAuth({
	providers: [
		GitHub({
			clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
			clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
		}),
	],
	callbacks: {
		async signIn({ profile }) {
			return isAllowedLogin(
				(profile as { login?: string } | undefined)?.login,
				allowlist,
			);
		},
	},
});
```

- [ ] **Step 3: Write the NextAuth route handler**

```ts
// dashboard/app/api/auth/[...nextauth]/route.ts
export { GET, POST } from "../../../../auth.js";
```

- [ ] **Step 4: Write `dashboard/middleware.ts`**

```ts
// dashboard/middleware.ts
import { NextResponse } from "next/server";
import { auth } from "./auth.js";

const PUBLIC_PATH_PREFIXES = ["/api/auth"];

export default auth((req) => {
	const isPublic = PUBLIC_PATH_PREFIXES.some((p) =>
		req.nextUrl.pathname.startsWith(p),
	);
	if (!req.auth && !isPublic) {
		return NextResponse.redirect(new URL("/api/auth/signin", req.nextUrl.origin));
	}
});

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=dashboard`
Expected: passes. (There's nothing to unit-test here — the real OAuth redirect/callback round-trip is manual/deferred, per the design spec's Testing section; it needs a registered GitHub OAuth App, which is one of the manual steps at the end of this plan.)

- [ ] **Step 6: Commit**

```bash
git add dashboard/auth.ts "dashboard/app/api/auth/[...nextauth]/route.ts" dashboard/middleware.ts dashboard/package.json package-lock.json
git commit -m "feat(dashboard): GitHub OAuth via Auth.js v5 with login allowlist"
```

**Post-implementation note (as actually built, verified against the installed `next@16.3.0`/`next-auth@5.0.0-beta.32` — this plan text was written before these were confirmed):**

1. **`dashboard/middleware.ts` → `dashboard/proxy.ts`.** Next.js 16 renamed the middleware file convention to `proxy.ts` (`middleware.ts` still works but logs a deprecation warning; having both hard-errors). The file's content is the same logic, just the filename and export changed: `export const proxy = auth((req) => {...})` (named export, not `export default`, per this project's no-default-exports convention) instead of `export default auth(...)` in a file named `middleware.ts`.
2. **Route handler export shape.** `dashboard/app/api/auth/[...nextauth]/route.ts` must be `import { handlers } from "../../../../auth"; export const { GET, POST } = handlers;` — not `export { GET, POST } from "..."`, since `auth.ts` exports a `handlers` object, not top-level `GET`/`POST`.
3. **No `.js` suffix on relative imports inside `dashboard/`.** This plan's remaining task snippets (Tasks 5-8 below) were written using this repo's root convention of `.js`-suffixed relative imports even for `.ts` source (per root CLAUDE.md, correct for the plain-`tsc`-built `src/`/`api/` tree). That convention **breaks the dashboard's production build**: Turbopack (the bundler behind `next build`/`next dev`) cannot resolve a `.js`-suffixed relative import to a same-tree `.ts`/`.tsx` file across directory boundaries, even though `tsc --noEmit` (and Vitest) resolve it fine — so the failure is invisible to `npm run typecheck --workspace=dashboard` and only surfaces as a hard build error. This was caught during Task 4's review (`dashboard/auth.ts`, the route handler, and `proxy.ts` all had to drop the `.js` suffix — see commit `4d03016`), and `.github/workflows/ci.yml` now runs `npm run build --workspace=dashboard` specifically to catch this class of bug going forward. **Every remaining task below has already been corrected to use extensionless relative imports for anything under `dashboard/` that a Next.js route/component/action file imports** (test-only files run through Vitest, not Turbopack, so their import style doesn't matter either way, but they've been kept consistent with their corresponding source file for clarity).

---

### Task 5: Data layer — `loadDashboardData`

**Files:**
- Create: `dashboard/lib/trends-data.ts`

- [ ] **Step 1: Install `server-only`**

```bash
npm install server-only --workspace=dashboard
```

- [ ] **Step 2: Write `dashboard/lib/trends-data.ts`**

```ts
// dashboard/lib/trends-data.ts
import "server-only";
import { getDb } from "../../src/improve/db/client";
import { listFindingOutcomes } from "../../src/improve/db/repo";
import {
	planProposals,
	thresholdsFromEnv,
	type ProposalPlan,
} from "../../src/improve/issues";
import {
	computeSeverityReliability,
	computeSkillSignals,
	detectDuplicateClusters,
} from "../../src/improve/trends";

export interface DashboardData {
	outcomes: Awaited<ReturnType<typeof listFindingOutcomes>>;
	severity: ReturnType<typeof computeSeverityReliability>;
	duplicates: ReturnType<typeof detectDuplicateClusters>;
	skills: ReturnType<typeof computeSkillSignals>;
	proposals: ProposalPlan[];
}

export async function loadDashboardData(): Promise<DashboardData> {
	const outcomes = await listFindingOutcomes(getDb());
	return {
		outcomes,
		severity: computeSeverityReliability(outcomes),
		duplicates: detectDuplicateClusters(outcomes),
		skills: computeSkillSignals(outcomes),
		proposals: planProposals(outcomes, thresholdsFromEnv(process.env)),
	};
}
```

`"server-only"` throws at build time if a client component ever imports this file transitively — a loud failure instead of silently trying to bundle `pg` toward the browser.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=dashboard`
Expected: passes. This is the first file that imports across the `dashboard/` → `src/improve/` boundary — if `moduleResolution`/relative-import resolution were going to break, it breaks here. (No unit test for this file: it's a thin composition of four already-tested pure/DB functions — `listFindingOutcomes` is covered by `src/improve/db/repo.integration.test.ts`, the trends functions by `src/improve/trends.test.ts`, `planProposals`/`thresholdsFromEnv` by `src/improve/issues.test.ts`. Re-mocking all four here to test a straight pass-through would test the mocks, not the code.)

- [ ] **Step 4: Commit**

```bash
git add dashboard/lib/trends-data.ts dashboard/package.json package-lock.json
git commit -m "feat(dashboard): load trends + proposals from the feedback corpus"
```

---

### Task 6: Views — severity/duplicates/skills tables + proposal cards (static)

**Files:**
- Modify: `dashboard/app/layout.tsx`
- Modify: `dashboard/app/page.tsx`
- Create: `dashboard/app/ProposalCard.tsx`

`ProposalCard` is built here as a plain Server Component (no button yet) — Task 8 converts it to a client component and wires the "open issue" action once `actions.ts` exists (Task 7). This keeps each task's diff focused on one concern.

- [ ] **Step 1: Replace `dashboard/app/layout.tsx`**

```tsx
// dashboard/app/layout.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { auth, signOut } from "../auth";
import "./globals.css";

export const metadata: Metadata = {
	title: "Feedback Loop Dashboard",
	description: "Internal dashboard for the ai-review-bot feedback loop corpus",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
	const session = await auth();
	return (
		<html lang="en">
			<body>
				<header
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						padding: "1rem",
						borderBottom: "1px solid #ccc",
					}}
				>
					<strong>Feedback Loop Dashboard</strong>
					{session?.user && (
						<form
							action={async () => {
								"use server";
								await signOut();
							}}
						>
							<span style={{ marginRight: "1rem" }}>
								{session.user.name ?? session.user.email}
							</span>
							<button type="submit">Sign out</button>
						</form>
					)}
				</header>
				<main style={{ padding: "1rem" }}>{children}</main>
			</body>
		</html>
	);
}
```

- [ ] **Step 2: Replace `dashboard/app/page.tsx`**

```tsx
// dashboard/app/page.tsx
import { loadDashboardData } from "../lib/trends-data";
import { ProposalCard } from "./ProposalCard";

export const runtime = "nodejs";

export default async function DashboardPage() {
	const { outcomes, severity, duplicates, skills, proposals } =
		await loadDashboardData();

	return (
		<div>
			<p>Findings with feedback: {outcomes.length}</p>

			<section>
				<h2>Severity reliability</h2>
				<table>
					<thead>
						<tr>
							<th>Severity</th>
							<th>Useful</th>
							<th>Low value</th>
							<th>Wrong</th>
							<th>Sample</th>
							<th>Useful %</th>
						</tr>
					</thead>
					<tbody>
						{severity.map((s) => (
							<tr key={s.severity}>
								<td>{s.severity}</td>
								<td>{s.useful}</td>
								<td>{s.lowValue}</td>
								<td>{s.wrong}</td>
								<td>{s.sampleSize}</td>
								<td>{Math.round(s.usefulRatio * 100)}%</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<section>
				<h2>Repeated claims ({duplicates.length} cluster(s))</h2>
				<ul>
					{duplicates.map((d) => (
						<li key={`${d.pr}:${d.path}:${d.identifier}`}>
							×{d.findingIds.length} #{d.pr} {d.path ?? "(no path)"} —{" "}
							<code>{d.identifier}</code>
							<ul>
								{d.titles.map((t, i) => (
									<li key={`${d.pr}:${d.identifier}:${i}`}>{t}</li>
								))}
							</ul>
						</li>
					))}
				</ul>
			</section>

			<section>
				<h2>Skill signals</h2>
				<table>
					<thead>
						<tr>
							<th>Skill</th>
							<th>Useful</th>
							<th>Negative</th>
							<th>Sample</th>
							<th>Negative %</th>
						</tr>
					</thead>
					<tbody>
						{skills.map((s) => (
							<tr key={s.skill}>
								<td>{s.skill}</td>
								<td>{s.useful}</td>
								<td>{s.negative}</td>
								<td>{s.sampleSize}</td>
								<td>{Math.round(s.negativeRatio * 100)}%</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<section>
				<h2>Proposals</h2>
				{proposals.length === 0 ? (
					<p>No signal above threshold.</p>
				) : (
					proposals.map((p) => <ProposalCard key={p.signature} plan={p} />)
				)}
			</section>
		</div>
	);
}
```

- [ ] **Step 3: Write `dashboard/app/ProposalCard.tsx` (static, unwired)**

```tsx
// dashboard/app/ProposalCard.tsx
import type { ProposalPlan } from "../../src/improve/issues";

export function ProposalCard({ plan }: { plan: ProposalPlan }) {
	return (
		<article
			style={{ border: "1px solid #ccc", padding: "1rem", marginBottom: "1rem" }}
		>
			<h3>{plan.title}</h3>
			<p>
				<strong>Kind:</strong> {plan.kind} · <strong>Target:</strong>{" "}
				<code>{plan.targetFile}</code>
			</p>
			<pre style={{ whiteSpace: "pre-wrap" }}>{plan.body}</pre>
		</article>
	);
}
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck --workspace=dashboard && npm run build --workspace=dashboard`
Expected: both pass. (`next build` will try to prerender/collect data for `page.tsx`, which calls `loadDashboardData()` → `getDb()` → requires `DATABASE_URL`. If you don't have a local `.env.local` with `DATABASE_URL` set yet, this build step will fail with a clear "DATABASE_URL is required" error — that's expected and fine to defer to Task 9 Step 1, where `.env.local` gets created; skip re-running the build here if so and rely on `typecheck` alone for this step.)

- [ ] **Step 5: Commit**

```bash
git add dashboard/app/layout.tsx dashboard/app/page.tsx dashboard/app/ProposalCard.tsx
git commit -m "feat(dashboard): render severity/duplicates/skills tables and proposal cards"
```

**Post-implementation note (found during Task 6, fixed in a follow-up commit `84eff81`):** wiring `page.tsx` to `loadDashboardData()` made Turbopack trace into `src/improve/*` for the first time — and those files' own internal `.js`-suffixed sibling imports (e.g. `db/repo.ts` importing `./schema.js`) failed to resolve, for the same reason Task 4's dashboard-internal imports failed before commit `4d03016`: Turbopack only maps `.js` specifiers to `.ts` files when the governing tsconfig's `moduleResolution` is `nodenext` (verified against Turbopack's own resolver source, not guessed), and `create-next-app`'s default of `"bundler"` disables that mechanism for the *entire* app, not just the files under `dashboard/`. Fix: `dashboard/tsconfig.json` now sets `"module": "nodenext"` / `"moduleResolution": "nodenext"`. This is a more foundational fix than `4d03016`'s workaround (which remains correct but is now redundant — the imports it fixed work for this deeper reason too, not because of the earlier extensionless-import change alone).

Side effect, also fixed in `84eff81`: `nodenext`'s stricter `node_modules` walk exposed a pre-existing, unrelated duplicate `react` version in the monorepo (root's `vitepress`→`@docsearch/react` pulls `react@18.3.1`; `dashboard` declares `react@19.2.8`), which made TypeScript merge `next-auth`'s `NextAuthRequest` against the wrong `next/server` types and silently drop its inherited `NextRequest` members (`nextUrl`, `url`, etc.) in `dashboard/proxy.ts`. Confirmed via `npx tsc --explainFiles`, not assumed. Fixed with a narrow, commented type cast in `proxy.ts` (`req as unknown as NextRequest & { auth: Session | null }`) rather than deduping `react` at the repo root — the object is a real `NextRequest` at runtime regardless of the broken inferred type, and repo-wide dependency pinning is out of scope and would touch the unrelated `vitepress` docs toolchain. **Confirmed with Joe via AskUserQuestion before applying** (three options presented: this narrow workaround, deduping react at the root, or importing built `dist/` output instead of `src/` source — this one was chosen as lowest blast-radius while still fixing the real root cause).

If Task 7 or Task 8 hits any further Turbopack resolution surprises, they should now be far less likely — `nodenext` fixes the mechanism project-wide, not per-file.

---

### Task 7: "Open issue from metric" server action (TDD)

**Files:**
- Create: `dashboard/app/actions.ts`
- Create: `dashboard/app/actions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/app/actions.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const installationOctokitMock = vi.fn();
const openProposalIssueMock = vi.fn();

vi.mock("../auth", () => ({ auth: authMock }));
vi.mock("../../src/improve/octokit", () => ({
	installationOctokit: installationOctokitMock,
}));
vi.mock("../../src/improve/issues", () => ({
	openProposalIssue: openProposalIssueMock,
}));

const { openIssueFromProposal } = await import("./actions");

const plan = {
	kind: "severity_reliability" as const,
	signature: "severity_reliability:high",
	title: "t",
	body: "b",
	targetFile: "src/prompt.ts",
};

describe("openIssueFromProposal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("refuses when there is no authenticated session", async () => {
		authMock.mockResolvedValue(null);

		const result = await openIssueFromProposal(plan);

		expect(result).toEqual({ action: "failed", error: "unauthenticated" });
		expect(installationOctokitMock).not.toHaveBeenCalled();
	});

	it("fails clearly when GitHub App credentials are not configured", async () => {
		authMock.mockResolvedValue({ user: { name: "Joe" } });
		vi.stubEnv("GITHUB_APP_ID", "");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");

		const result = await openIssueFromProposal(plan);

		expect(result.action).toBe("failed");
		expect(installationOctokitMock).not.toHaveBeenCalled();
	});

	it("stays dry-run by default (DASHBOARD_DRY_RUN unset)", async () => {
		authMock.mockResolvedValue({ user: { name: "Joe" } });
		vi.stubEnv("GITHUB_APP_ID", "app-1");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "key");
		vi.stubEnv("IMPROVE_TARGET_REPO", "o/r");
		installationOctokitMock.mockResolvedValue({ marker: "octokit" });
		openProposalIssueMock.mockResolvedValue({ action: "would_create" });

		await openIssueFromProposal(plan);

		expect(openProposalIssueMock).toHaveBeenCalledWith({
			octokit: { marker: "octokit" },
			owner: "o",
			repo: "r",
			plan,
			dryRun: true,
		});
	});

	it("goes live only when DASHBOARD_DRY_RUN=false, using an installation Octokit", async () => {
		authMock.mockResolvedValue({ user: { name: "Joe" } });
		vi.stubEnv("GITHUB_APP_ID", "app-1");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "key");
		vi.stubEnv("IMPROVE_TARGET_REPO", "o/r");
		vi.stubEnv("DASHBOARD_DRY_RUN", "false");
		installationOctokitMock.mockResolvedValue({ marker: "octokit" });
		openProposalIssueMock.mockResolvedValue({
			action: "created",
			url: "https://github.com/o/r/issues/1",
		});

		const result = await openIssueFromProposal(plan);

		expect(installationOctokitMock).toHaveBeenCalledWith("app-1", "key", "o", "r");
		expect(openProposalIssueMock).toHaveBeenCalledWith({
			octokit: { marker: "octokit" },
			owner: "o",
			repo: "r",
			plan,
			dryRun: false,
		});
		expect(result).toEqual({
			action: "created",
			url: "https://github.com/o/r/issues/1",
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=dashboard`
Expected: FAIL — `dashboard/app/actions.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// dashboard/app/actions.ts
"use server";

import "server-only";
import {
	openProposalIssue,
	type IssueOctokit,
	type ProposalPlan,
} from "../../src/improve/issues";
import { installationOctokit } from "../../src/improve/octokit";
import { auth } from "../auth";

export interface OpenIssueResult {
	action: "created" | "commented" | "would_create" | "would_comment" | "failed";
	url?: string;
	error?: string;
}

/** Gated behind DASHBOARD_DRY_RUN so the first deploy can be exercised without
 * filing real issues. Unset or any value other than the literal "false" stays
 * in dry-run — flip to "false" only after manually verifying one real
 * create/comment against a scratch repo (see the design spec's Manual steps). */
export async function openIssueFromProposal(
	plan: ProposalPlan,
): Promise<OpenIssueResult> {
	const session = await auth();
	if (!session?.user) return { action: "failed", error: "unauthenticated" };

	const slug = process.env.IMPROVE_TARGET_REPO ?? "joeblackwaslike/ai-review-bot";
	const [owner, repo] = slug.split("/");
	const appId = process.env.GITHUB_APP_ID;
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
	if (!appId || !privateKey || !owner || !repo) {
		return {
			action: "failed",
			error: "GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/IMPROVE_TARGET_REPO not configured",
		};
	}

	const octokit = (await installationOctokit(
		appId,
		privateKey,
		owner,
		repo,
	)) as unknown as IssueOctokit;

	const dryRun = process.env.DASHBOARD_DRY_RUN !== "false";
	return openProposalIssue({ octokit, owner, repo, plan, dryRun });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --workspace=dashboard`
Expected: PASS (4 tests in this file).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=dashboard`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add dashboard/app/actions.ts dashboard/app/actions.test.ts
git commit -m "feat(dashboard): open-issue-from-metric server action, dry-run gated"
```

---

### Task 8: Wire the button

**Files:**
- Modify: `dashboard/app/ProposalCard.tsx`

- [ ] **Step 1: Convert `ProposalCard` to a client component with the action wired**

```tsx
// dashboard/app/ProposalCard.tsx
"use client";

import { useState, useTransition } from "react";
import type { ProposalPlan } from "../../src/improve/issues";
import { openIssueFromProposal, type OpenIssueResult } from "./actions";

export function ProposalCard({ plan }: { plan: ProposalPlan }) {
	const [isPending, startTransition] = useTransition();
	const [result, setResult] = useState<OpenIssueResult | null>(null);

	function handleClick() {
		startTransition(async () => {
			setResult(await openIssueFromProposal(plan));
		});
	}

	return (
		<article
			style={{ border: "1px solid #ccc", padding: "1rem", marginBottom: "1rem" }}
		>
			<h3>{plan.title}</h3>
			<p>
				<strong>Kind:</strong> {plan.kind} · <strong>Target:</strong>{" "}
				<code>{plan.targetFile}</code>
			</p>
			<pre style={{ whiteSpace: "pre-wrap" }}>{plan.body}</pre>
			<button type="button" onClick={handleClick} disabled={isPending}>
				{isPending ? "Opening…" : "Open issue from metric"}
			</button>
			{result && (
				<p>
					{result.action === "failed"
						? `Failed: ${result.error ?? "unknown error"}`
						: `${result.action}${result.url ? ` — ${result.url}` : ""}`}
				</p>
			)}
		</article>
	);
}
```

A `"use server"`-marked export is safe to import directly from a client component — Next.js replaces the import with a server-action reference at build time rather than bundling `actions.ts`'s real body (and its `pg`/Octokit dependencies) into the client bundle. `page.tsx` (a Server Component) still imports and renders `ProposalCard` with a plain serializable `ProposalPlan` prop — that Server→Client composition boundary is standard.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=dashboard`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add dashboard/app/ProposalCard.tsx
git commit -m "feat(dashboard): wire open-issue button to the server action"
```

---

### Task 9: Env vars, docs, final verification

**Files:**
- Modify: `.env.example` (root)
- Create: `dashboard/.env.local` (untracked — local only, not committed)

- [ ] **Step 1: Add the 5 net-new vars to root `.env.example`**

Insert this new block after the existing `# --- QC app ...` section (after line 97, before the `# --- Peer-aware review delay ---` section):

```
# --- Dashboard (Phase 8, dashboard/) — separate Vercel project ---
# Reuses DATABASE_URL, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, IMPROVE_* above.
# See docs/superpowers/specs/2026-08-11-feedback-loop-phase8-dashboard-design.md.
# A fresh GitHub OAuth App (github.com/settings/developers) — NOT the GitHub App
# used by the review bots.
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
# Generate with: npx auth secret
AUTH_SECRET=
# Comma-separated GitHub logins allowed to sign in.
DASHBOARD_ALLOWED_LOGIN=
# Gates the "open issue from metric" button. Unset or any value other than the
# literal "false" stays in dry-run (would_create/would_comment, no real GitHub
# write). Flip to "false" only after manually verifying one real issue-create.
DASHBOARD_DRY_RUN=true
```

Never prefix any of these with `NEXT_PUBLIC_` — that ships them to the client bundle.

- [ ] **Step 2: Create your local `dashboard/.env.local` for manual verification**

Not committed (`dashboard/.gitignore`'s `.env*` line already covers it). Populate with a real pooled `DATABASE_URL`, a registered GitHub OAuth App's `GITHUB_OAUTH_CLIENT_ID`/`_SECRET` (see Manual steps below — you need to register this first), an `AUTH_SECRET` from `npx auth secret`, your own GitHub login in `DASHBOARD_ALLOWED_LOGIN`, and `DASHBOARD_DRY_RUN=true`.

- [ ] **Step 3: Full local verification**

```bash
npm run dev --workspace=dashboard
```

Visit `http://localhost:3000`. Confirm: signed-out redirects to GitHub sign-in; signing in with an allowlisted login succeeds and shows the three tables with real corpus data; signing in with a non-allowlisted login is rejected; a proposal's "Open issue from metric" button (if any proposal is above threshold) returns a `would_create`/`would_comment` result while `DASHBOARD_DRY_RUN=true`.

- [ ] **Step 4: Run every quality gate**

```bash
npm run typecheck && npm run lint && npm run test
npm run typecheck --workspace=dashboard
npm run test --workspace=dashboard
npm run build --workspace=dashboard
```

All must pass. The root three must show unchanged behavior outside the `installationOctokit` extraction from Task 1 (which has its own RED→GREEN test).

- [ ] **Step 5: Commit**

```bash
git add .env.example
git commit -m "docs(env): document dashboard OAuth + allowlist + dry-run vars"
```

**Post-implementation note:** Step 1's `.env.example` block was already added during Task 4's fix-up (commit `623c46b`, folded in when that task's code review flagged the missing env-var docs) — verified byte-identical to what this step specifies, nothing further to commit for it. Step 4 (all quality gates) was run and confirmed green: root `typecheck`/`lint`/`test` (625 passed, 4 skipped — pre-existing DB-integration skips) and dashboard `typecheck`/`test` (12 passed) /`build` (Turbopack, succeeds). **Steps 2-3 (local `.env.local` + `npm run dev` verification against a real GitHub OAuth App and real `DATABASE_URL`) and the entire "Manual steps only Joe can do" section below remain genuinely manual** — they require credentials and access (registering a GitHub OAuth App, a live pooled `DATABASE_URL`, a Vercel project) that don't exist in an agent's sandboxed worktree. An agent executing this plan should stop here and hand off to Joe rather than attempting to fabricate or skip these steps.

---

## Manual steps only Joe can do (not part of this plan's automated tasks)

These require access to GitHub App/OAuth settings and the Vercel dashboard, which an agent executing this plan cannot do unattended:

1. Register a new GitHub **OAuth App** (github.com/settings/developers) for dashboard login — a fresh app, not the GitHub App the review bots use.
2. Create the new Vercel project with Root Directory = `dashboard`. Verify "Include source files outside of the Root Directory in the Build Step" is on for this specific project (default-on for projects created after 2020-08-27, per the design spec — confirm it explicitly anyway). Set env vars from §5 of the design spec, ideally via Vercel Shared Environment Variables for the values reused from the existing project (`DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `IMPROVE_*`).
3. First deploy → note the assigned domain → add its `/api/auth/callback/github` URL back into the OAuth App's callback URL settings.
4. Sign in once on the deployed URL to confirm the allowlist admits your account.
5. Manually verify one real issue-create/comment against a scratch repo before flipping `DASHBOARD_DRY_RUN` to `"false"` in the Vercel project's env vars.
6. Post-deploy regression check: confirm the *existing* bot webhooks/cron are unaffected — they're on a completely separate, untouched Vercel project, but verify anyway (e.g. trigger a PR comment and confirm a review still posts).

## Risks / footguns carried over from the design spec

- **Neon connection limits:** the dashboard is a third concurrent consumer of the pooled `DATABASE_URL` (alongside the webhook project and the weekly cron). If connection exhaustion appears, confirm the pooled (PgBouncer-fronted) string is used here too, and consider capping `pg.Pool`'s `max` in `src/improve/db/client.ts` (currently unset → node-postgres default of 10).
- **`GITHUB_APP_PRIVATE_KEY` format:** must be pasted into the new Vercel project with the same `\n`-escaping the existing project's value uses — a mismatch only surfaces at runtime (auth failure), not build time.
- **Auth.js v5 beta churn:** re-verify `dashboard/auth.ts`/`proxy.ts`/`actions.ts`'s sign-out pattern against the installed version's current docs if you bump `next-auth` later; don't assume the shape in this plan is still current.
- **`npm publish` sanity:** the root `package.json` is a published npm package (`ai-review-bot` CLI, via `files`/`bin`). Adding `"workspaces"` to it is harmless for consumers (npm ignores that field on install), but if you ever run `npm publish` for this package, a quick `npm publish --dry-run` first is cheap insurance that the `files` allowlist still excludes `dashboard/`.

## Self-review notes (from writing this plan)

- **Spec coverage:** every section of the design spec (repo layout, auth, data views + action, `installationOctokit` extraction, env vars, testing) maps to a task above. The one item the design spec explicitly marks out of scope — QC scores / `qc_runs` views — has no task here either, correctly.
- **Type consistency check:** `ProposalPlan` (Task 5/6/7/8), `OpenIssueResult` (Task 7/8), and `DashboardData` (Task 5/6) are defined once and referenced identically by name everywhere they're used across tasks.
- **Deviation from the spec's illustrative code, called out explicitly:** the spec's `actions.ts` snippet (§3) doesn't show `dryRun` being passed to `openProposalIssue`, but the spec's surrounding prose explicitly requires gating the button behind `DASHBOARD_DRY_RUN` for the first deploy. Task 7 implements that gate for real (default dry-run unless `DASHBOARD_DRY_RUN=false`) since the prose is the actual requirement and the code sample was illustrative, not exhaustive.
