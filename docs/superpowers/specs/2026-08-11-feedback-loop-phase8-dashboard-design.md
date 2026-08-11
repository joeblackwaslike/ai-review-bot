# Feedback Loop — Phase 8 Dashboard — Design Spec

**Status:** Approved (research + plan review) — ready for implementation
**Date:** 2026-08-11
**Beads:** `ai-review-bot-vms` (Phase 8: build), `ai-review-bot-g8q` (coexistence spike — resolved by this spec), `ai-review-bot-x4c` (epic)
**Builds on:** `docs/superpowers/specs/2026-06-21-feedback-improvement-loop-design.md` (Phases 1–7; the corpus, capture, classify+match, trends, QC app, issues, CLI+cron already built/partially built)

## Goal

Ship the Phase 8 dashboard: a Joe-only, GitHub-OAuth-gated Next.js app that reads the Neon corpus built in Phases 1–7 and mirrors what `ai-review trends --json` / `ai-review propose --dry-run` already compute, with a button to open a GitHub issue from a metric ("open issue from metric"). This closes out the interim CLI-only mitigation the backlog has been running on (`docs/_backlog.md` → "Dashboard (Phase 8)").

## Why this spec exists (deviation from the parent spec)

The 2026-06-21 spec assumed the dashboard would be Next.js in the **same** Vercel project as the existing root-level `api/*.ts` webhook/QStash functions (decision table line 41, §"Dashboard", Risks, Open Questions #1). Bead `ai-review-bot-g8q` flagged that assumption as the single highest-risk unknown and explicitly said not to act on it unattended: getting it wrong breaks GitHub webhook HMAC verification and the QStash callback in production, silently, for every repo.

This spec resolves that unknown and **supersedes the parent spec's "same Vercel project" framing** in every location it appears.

### Research finding

Root-level Node.js `/api` functions and a Next.js app's own `app/api` Node routes do not reliably coexist in one Vercel project. Cross-checked against GitHub/Vercel community discussions and Vercel's own guidance: Vercel recommends keeping all Node serverless functions inside Next.js's own routing (`app/api/`/`pages/api/`), and the build system can silently merge or override files when a root `/api` and Next's own API routes both exist for the same (Node) runtime. The only well-supported same-project coexistence pattern is root `/api` for a *different* runtime (e.g. Python) alongside Next's Node routes — not this repo's case, since `api/*.ts` here are Node/TypeScript doing raw-body HMAC verification.

### Decision (Joe, confirmed via AskUserQuestion)

Deploy the dashboard as a **separate Vercel project** — a new project rooted at a `dashboard/` subdirectory of this same git repo, with its own domain and env vars. The existing root project (`api/*.ts`, `vercel.json`, both GitHub App webhooks, the QStash callback) is left completely untouched — zero risk to production. Confirmed viable via Vercel's monorepo docs: "Can I share source files between projects? ... enable 'Include source files outside of the Root Directory in the Build Step'" — default-on for projects created after 2020-08-27, and Vercel explicitly supports multiple projects (each its own domain) pointed at different roots of one repo.

### Corrected mechanism for code sharing (found during plan review)

npm workspaces cannot make the workspace **root** package resolvable as a named dependency from a member package — only members listed in `workspaces: [...]` get symlinked into the shared `node_modules`; the root is never symlinked into itself. So `dashboard/` cannot `import` from a package literally named `ai-review-bot`. The working mechanism:

- `dashboard/` is an npm workspace member (`"workspaces": ["dashboard"]` in root `package.json`) purely so **one `npm install` at the repo root** wires up a shared `node_modules`, and so Vercel's npm-workspaces auto-detection installs correctly for a project rooted at `dashboard/`.
- Dashboard code imports `src/improve/*` by **relative filesystem path** (`../../src/improve/db/client.js`, etc.) — ordinary files to Next's compiler, not `node_modules` packages, so no `transpilePackages` config applies.
- `dashboard/next.config.ts` sets `outputFileTracingRoot` to the monorepo root — without it, Vercel's file tracer (`@vercel/nft`) can tree-shake `src/improve/**` out of the deployed function bundle even though local `next build` works fine (a build that passes locally but 404s/500s in prod).

## What already exists (reuse, don't reinvent — verified by reading the code)

| Module | Reuse |
|---|---|
| `src/improve/db/schema.ts` | 7-table Drizzle Postgres schema. Its docstring on `getDb()` already anticipates dashboard reuse. |
| `src/improve/db/client.ts` | `getDb(): Db` — lazy pooled singleton over `DATABASE_URL`. `resetDbSingleton()` for tests. |
| `src/improve/db/repo.ts` | `listFindingOutcomes(db): Promise<FindingOutcome[]>` — the one broad read query the dashboard needs (raw SQL join of `classified_feedback`↔`finding_catalog`). Everything else in `repo.ts` is write-oriented (capture/classify/QC pipeline), not needed here. |
| `src/improve/trends.ts` | Pure functions over `FindingOutcome[]`: `computeSeverityReliability`, `detectDuplicateClusters`, `computeSkillSignals`. |
| `src/improve/issues.ts` | `thresholdsFromEnv(env)`, `planProposals(outcomes, thresholds): ProposalPlan[]`, `openProposalIssue(deps): Promise<{action, url?}>` — the exact "open issue from metric" function. Dedup is via a marker string searched in GitHub issue bodies (`GET /search/issues`), **not** the `proposals` table. |
| `src/cli.ts` `cmdTrends`/`cmdPropose` | Exact JSON envelope to mirror: `{severity, duplicates, skills}`. `cmdPropose`'s installation-Octokit construction is the pattern the dashboard's server action follows (see extraction below). |

**Important discovery:** the `trends`/`proposals` tables defined in `schema.ts` are unused — nothing inserts into them anywhere in the codebase today. A "trend" is a value computed live on every CLI/cron invocation from `listFindingOutcomes()`, not a persisted row. The dashboard does the same: compute live, do not query trend history.

## Architecture

### 1. Repo layout

```text
ai-review-bot/                  (existing root project — untouched)
├── api/*.ts                    (webhooks, QStash callback, crons — unchanged)
├── src/improve/*                (shared corpus logic — imported by relative path)
├── vercel.json                 (existing project only)
├── package.json                (+ "workspaces": ["dashboard"])
└── dashboard/                  (NEW — separate Vercel project, Root Directory = dashboard/)
    ├── app/
    │   ├── page.tsx             (Server Component — trends + proposals views)
    │   ├── ProposalCard.tsx     ("use client" — open-issue button)
    │   ├── actions.ts           ("use server" — openIssueFromProposal)
    │   ├── layout.tsx
    │   └── api/auth/[...nextauth]/route.ts
    ├── lib/
    │   ├── allowlist.ts         (pure — parseAllowlist / isAllowedLogin)
    │   └── trends-data.ts       (server-only — loadDashboardData)
    ├── auth.ts                  (Auth.js v5 config)
    ├── middleware.ts            (route protection)
    ├── next.config.ts           (outputFileTracingRoot)
    ├── tsconfig.json
    ├── vitest.config.ts
    └── package.json
```

Root `tsconfig.json`/`vitest.config.ts` stay scoped to `api/**`/`src/**` — untouched. `biome.json`'s `files.includes: ["**"]` already covers `dashboard/**` with zero config change.

### 2. Auth — Auth.js v5, GitHub OAuth, allowlist

`next-auth@beta` (pin an exact version — Auth.js v5 is still beta-only; re-verify after any bump, betas have shipped breaking changes between each other).

```ts
// dashboard/lib/allowlist.ts — pure, unit-tested
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export function isAllowedLogin(login: string | null | undefined, allowlist: string[]): boolean {
  if (!login) return false;
  return allowlist.includes(login.toLowerCase());
}
```

```ts
// dashboard/auth.ts — imports nothing from src/improve/db/* (stays edge/middleware-safe)
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { isAllowedLogin, parseAllowlist } from "./lib/allowlist";

const allowlist = parseAllowlist(process.env.DASHBOARD_ALLOWED_LOGIN);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub({ clientId: process.env.GITHUB_OAUTH_CLIENT_ID, clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET })],
  callbacks: {
    async signIn({ profile }) {
      return isAllowedLogin((profile as { login?: string } | undefined)?.login, allowlist);
    },
  },
});
```

`dashboard/middleware.ts` protects every route except `api/auth/*` and static assets via `auth((req) => { if (!req.auth) redirect })`.

### 3. Data views + "open issue from metric" action

```ts
// dashboard/lib/trends-data.ts
import "server-only";
import { getDb } from "../../src/improve/db/client.js";
import { listFindingOutcomes } from "../../src/improve/db/repo.js";
import { computeSeverityReliability, computeSkillSignals, detectDuplicateClusters } from "../../src/improve/trends.js";
import { planProposals, thresholdsFromEnv, type ProposalPlan } from "../../src/improve/issues.js";

export async function loadDashboardData() {
  const outcomes = await listFindingOutcomes(getDb());
  return {
    outcomes,
    severity: computeSeverityReliability(outcomes),
    duplicates: detectDuplicateClusters(outcomes),
    skills: computeSkillSignals(outcomes),
    proposals: planProposals(outcomes, thresholdsFromEnv(process.env)) as ProposalPlan[],
  };
}
```

`dashboard/app/page.tsx` (`export const runtime = "nodejs"`, Server Component) renders severity reliability / duplicate clusters / skill signals as tables — same shape `cmdTrends` prints — plus a Proposals section. `dashboard/app/ProposalCard.tsx` (`"use client"`) shows one `ProposalPlan` with a button that calls the server action via `useTransition` and renders the result.

```ts
// dashboard/app/actions.ts
"use server";
import "server-only";
import { auth } from "../auth";
import { openProposalIssue, type IssueOctokit, type ProposalPlan } from "../../src/improve/issues.js";
import { installationOctokit } from "../../src/improve/octokit.js";

export interface OpenIssueResult { action: "created" | "commented" | "would_create" | "would_comment" | "failed"; url?: string; error?: string; }

export async function openIssueFromProposal(plan: ProposalPlan): Promise<OpenIssueResult> {
  const session = await auth();
  if (!session?.user) return { action: "failed", error: "unauthenticated" };
  const slug = process.env.IMPROVE_TARGET_REPO ?? "joeblackwaslike/ai-review-bot";
  const [owner, repo] = slug.split("/");
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey || !owner || !repo) {
    return { action: "failed", error: "GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/IMPROVE_TARGET_REPO not configured" };
  }
  const octokit = (await installationOctokit(appId, privateKey, owner, repo)) as unknown as IssueOctokit;
  return openProposalIssue({ octokit, owner, repo, plan });
}
```

Gate the button behind a `DASHBOARD_DRY_RUN` env flag for the first deploy; flip off once the create/comment path is manually verified.

**Explicitly out of scope for this MVP:** QC scores / `qc_runs` views. Phase 5 (QC app, bead `ai-review-bot-8nq`) is still partial and the data is sparse — a fast-follow once that phase completes, not a stub route now.

### 4. Extract `installationOctokit` (prep refactor, own commit before touching `dashboard/`)

`src/cli.ts` (lines 135–150) and `api/cron/improve.ts` (lines 32–43) each independently build an installation-authenticated Octokit with identical logic — a live duplication. Extract to a new shared file:

```ts
// src/improve/octokit.ts
import { App } from "octokit";

/** Build an Octokit authenticated as one GitHub App's installation on a repo.
 * Shared by the CLI (`ai-review propose`/`ready`/`backfill`), the weekly cron
 * (`api/cron/improve.ts`), and the dashboard's "open issue from metric" action. */
export async function installationOctokit(appId: string, privateKey: string, owner: string, repo: string) {
  const app = new App({ appId, privateKey: privateKey.replaceAll(String.raw`\n`, "\n") });
  const { data: inst } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
  return app.getInstallationOctokit(inst.id);
}
```

`cli.ts` and `api/cron/improve.ts` import this instead of their own copies. TDD: `src/improve/octokit.test.ts` first (RED, mocking `octokit`'s `App`), then extract, confirm `typecheck`/`lint`/`test` stay green — pure mechanical extraction, no behavior change.

### 5. Env vars — new Vercel project

| Var | Source | Notes |
|---|---|---|
| `DATABASE_URL` | shared value | same pooled Neon string |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | shared value | Claude bot's existing App; paste the same `\n`-escaped key format already in use |
| `IMPROVE_TARGET_REPO`, `IMPROVE_MIN_SAMPLE`, `IMPROVE_MAX_USEFUL_RATIO`, `IMPROVE_MIN_CLUSTERS`, `IMPROVE_MIN_NEGATIVE_RATIO` | shared value, optional | code defaults apply if unset |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | **net-new** | a fresh **GitHub OAuth App** (not the GitHub App used by the bots) |
| `AUTH_SECRET` | **net-new** | `npx auth secret` |
| `DASHBOARD_ALLOWED_LOGIN` | **net-new** | comma-separated GitHub logins |

Add the 4 net-new vars to root `.env.example`. Never prefix any of these with `NEXT_PUBLIC_` — that ships them to the client bundle.

### 6. Testing

- `dashboard/lib/allowlist.test.ts` — pure, no mocks.
- `src/improve/octokit.test.ts` — mocks only `octokit`'s `App` (the network boundary).
- `dashboard/app/actions.test.ts` — mocks `auth()` and `installationOctokit`/`openProposalIssue`; asserts correct calls when authenticated, refusal when not. Don't re-mock `openProposalIssue`'s internals (already covered by `src/improve/issues.test.ts`).
- Manual/deferred (not Vitest-exercisable): the real OAuth redirect/callback round-trip; the first real issue-create (behind `DASHBOARD_DRY_RUN` first).

## Build sequence

1. **Prep refactor** (root, TDD, own commit): extract `installationOctokit`, update both call sites, confirm root gates green.
2. Scaffold `dashboard/` (`create-next-app`, no ESLint/Tailwind), delete its nested lockfile, add `"workspaces": ["dashboard"]` to root `package.json`, one `npm install` from root.
3. `next.config.ts` (`outputFileTracingRoot`), `tsconfig.json`, `.next/` added to root `.gitignore`.
4. Auth: `allowlist.ts` (+ test), `auth.ts`, NextAuth route handler, `middleware.ts`; `dashboard/vitest.config.ts`.
5. Data layer: `lib/trends-data.ts`.
6. Views: `layout.tsx`, `page.tsx`, `ProposalCard.tsx`.
7. Action: `actions.ts` (+ test, RED first).
8. Wire button → action → render result.
9. Local verification: `dashboard/.env.local`, `npm run dev --workspace=dashboard` against real (read-only) `DATABASE_URL`.
10. `npm run typecheck && npm run lint` at root + `npm run typecheck --workspace=dashboard`; `npm test` at root + `npm test --workspace=dashboard` — all green.
11. Update root `.env.example`.

**Manual steps only Joe can do:**
- Register a new GitHub **OAuth App** (github.com/settings/developers) for dashboard login.
- Create the new Vercel project (Root Directory = `dashboard`), verify "Include source files outside of the Root Directory" is on for this specific project, set env vars (§5, ideally via Vercel Shared Environment Variables for the reused ones).
- First deploy → note the assigned domain → add its `/api/auth/callback/github` URL back into the OAuth App.
- Sign in once to confirm the allowlist admits Joe's account; manually verify one real issue-create/comment before turning off `DASHBOARD_DRY_RUN`.

## Risks / footguns

- **Neon connection limits:** the dashboard reuses the exact `getDb()` singleton pattern. It's a genuinely separate deployed process, but that's precisely the 3rd consumer the parent spec's Risks section already priced in ("cron+webhook+dashboard concurrency exhausts connections") — being a separate project changes nothing about that math. Mitigation if it bites: confirm `DATABASE_URL` is the pooled (PgBouncer-fronted) string here too; cap `pg.Pool`'s `max` in `db/client.ts` if needed (currently unset → node-postgres default of 10).
- **`GITHUB_APP_PRIVATE_KEY` format:** must be pasted with the same `\n`-escaping the existing project's value uses — a mismatch only surfaces at runtime (auth failure), not build time.
- **`server-only` import guard:** add to `lib/trends-data.ts` and `app/actions.ts` so an accidental client-component import of DB/Octokit code fails the build loudly instead of silently trying to bundle `pg` toward the browser.
- **Nested lockfile:** delete `dashboard/package-lock.json` immediately after scaffolding — npm workspaces doesn't support a member having its own lockfile.
- **Auth.js v5 beta churn:** pin an exact `next-auth` version, don't float.

## Verification

- `npm run typecheck && npm run lint && npm test` green at repo root (unchanged behavior outside the `installationOctokit` extraction, which has its own RED→GREEN test).
- `npm run typecheck --workspace=dashboard && npm test --workspace=dashboard` green.
- `npm run build --workspace=dashboard` succeeds (catches `outputFileTracingRoot`/relative-import wiring before Vercel does).
- `npm run dev --workspace=dashboard` locally: sign-in allowlist works both ways, the three tables render real corpus data, a proposal's "open issue" button works end-to-end against a scratch repo before pointing at the real one.
- Post-deploy: repeat login + one issue-open check against the live Vercel project; confirm the existing bot webhooks/cron are unaffected (untouched, separate project).
