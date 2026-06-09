# Design Spec — Local-Tree Audit → Synthetic-Base Review PR

**Date:** 2026-06-08
**Status:** Approved design, pre-implementation
**Author:** Joe Black (with Claude)
**Working notes:** `~/.claude/plans/federated-sniffing-zephyr.md`

---

## Context

`ai-review` ships an npm CLI ([src/cli.ts](../../../src/cli.ts) → [src/audit.ts](../../../src/audit.ts)) that runs the five Tier-1 review agents over a repository. Today it surfaces results two ways only:

- **Default:** creates a GitHub Issue (`POST .../issues`, [src/audit.ts:204-210](../../../src/audit.ts#L204-L210)) with a findings list and an inline-notes table **truncated to 120 chars** ([src/audit.ts:260](../../../src/audit.ts#L260)).
- **`--dry-run`:** prints that markdown to stdout.

Two structural gaps for the goal — *a coding agent in the repo gets the best possible report to implement fixes fast, then gets re-reviewed after pushing a PR*:

1. It audits the **remote** repo via the GitHub API ([src/audit.ts:73-120](../../../src/audit.ts#L73-L120)), so it cannot see the **uncommitted local changes** an agent is actively editing.
2. The issue is **lossy and human-shaped** — truncated, prose, no machine-readable structure, no actionable `path:line` anchors.

No branch/PR/commit-creation code exists in `src/` today; the only GitHub writes are issue creation and PR-review posting on *existing* PRs. The PR re-review path is fully wired via `maybeSubmitReview()` on `pull_request.opened/reopened/synchronize/ready_for_review` ([src/github-app.ts:349-353](../../../src/github-app.ts#L349-L353)).

## Goals

- Audit the **local working tree** including uncommitted changes.
- Deliver findings into a coding agent's context (via a Claude Code plugin command) for immediate action.
- Persist findings as a **real GitHub PR review with inline comments**, drivable by `/pr-loop` and the existing re-review webhook, serving humans/CI as well as the agent.
- Land fixes on the default branch cleanly, with bounded review cost for the rest of the PR's life.
- **Reduce GitHub API/GraphQL load.** The remote audit makes one API call *per file* to fetch blob contents ([src/audit.ts:96-120](../../../src/audit.ts#L96-L120)); the local-tree path reads from disk and makes **zero**. This directly cuts the call volume that currently triggers rate-limiting and stalls `/pr-loop`.

## Non-goals

- No change to the existing webhook PR-review behavior (it already handles re-review).
- No agentic auto-fixing inside the CLI — the CLI surfaces findings; `/pr-loop` (or the human) implements fixes.
- No support for non-Claude-Code agent front-ends in v1 (the underlying CLI stays portable for CI/humans).

---

## Architecture

### The core mechanism: orphan base + retarget

GitHub PR diffs are **three-dot** (`merge-base(base, head)..head`). An unchanged line is only commentable inline if the file differs between the merge-base and head. An audit changes nothing vs the default branch, so there is no diff to comment on — the wall.

**Escape:** base the audit PR on an **orphan branch** with no shared history. `merge-base = ∅`, so the diff renders the **entire head tree as additions** — every line is a valid RIGHT-side line, so any finding can be posted as an inline comment. This reuses `collectRightSideLines()` / `buildReviewComments()` ([src/review.ts:276](../../../src/review.ts#L276), [src/review.ts:325](../../../src/review.ts#L325)) unchanged.

**Clean merge:** the head branch is cut from the default branch, so it is literally `default + [fix commits]`. After first-pass fixes, the `ready` step **`PATCH /pulls/{n}` retargets base → default branch**. The diff recomputes as `default...head` = only the fixes — an ordinary, mergeable PR. Audit-stage comments on lines the agent didn't touch fall outside the new diff and GitHub auto-marks them **outdated/collapsed**. No synthetic content ever enters the default branch's lineage.

### Terminology

- **Base branch** — the branch a PR proposes to merge *into*. The audit PR opens with base = `ai-review/empty` (the orphan trick); the `ready` step changes it to the default branch.
- **Retarget** — change a PR's base branch (`ai-review/empty` → default branch). Recomputes the diff to just the fixes.
- **Draft / mark ready** — a draft PR is "not ready"; most bots (ours included) skip drafts. "Mark ready" flips Draft → Ready for review, which wakes the reviewers.

### Components

Each unit has one purpose, a defined interface, and is independently testable.

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| **File sources** | `src/sources.ts` *(new)* | `collectFilesFromLocal({cwd, mode})` — `changed` (default) = `git diff --name-only <merge-base default>` ∪ `git status --porcelain` (uncommitted, incl. rename handling); `full` = `git ls-files`. Filters via `hasCodeExtension`. Reads via `node:fs/promises`. Git invoked through a small injectable runner so tests stub output. (Implementation note: the *remote* fetch stays inline in the legacy `auditRepo` — it was not extracted, to keep the refactor minimal on the deprecated path.) | `git`, `hasCodeExtension` |
| **Audit core** | `src/audit.ts` *(refactor)* | `runAuditPass({files, provider, extraInstructions})` → `TIER1_SKILLS` via `runAgent` → `mergeReviews` → one `ModelReview`. Orchestrator always runs **both** providers. `auditRepo()` stays as the thin remote entry. | `runAgent`, `mergeReviews`, `routeModel`, `TIER1_SKILLS` |
| **Artifact writer** | `src/audit.ts` | Writes `.ai-review/audit-<provider>.json` (untruncated `{meta, review}`, `meta.pr` set once the PR exists) + combined `audit.md` (task-list + `path:line` anchors). | `node:fs/promises` |
| **Review-PR machinery** | `src/audit-pr.ts` *(new)* | `ensureOrphanBase()`, `createHeadBranch()`, `openDraftPr()` (applies the `AI audit` label), `postProviderReview()` (×2 identities), `makeReady()` (retarget base→default branch + un-draft, backing `ai-review ready`). | Octokit (both App identities), `buildReviewComments` |
| **Plugin command** | *(deferred — see Open items)* | Orchestrates: `ai-review audit` → inject findings → first-pass fixes against the draft PR's inline comments → `ai-review ready` → hand off to `/pr-loop`. | the CLI |

### CLI surface (two subcommands, backward-compatible)

**`ai-review audit [options]`** — audits the local working tree (changed files by default), runs both review passes, writes artifacts, and opens a draft review PR. Prints the PR URL.

| Option | Type | Default | Description |
|---|---|---|---|
| `--full` | boolean | `false` (changed-only) | Audit the entire tracked tree (`git ls-files`) instead of just changed files. Changed = diff vs the default branch's merge-base ∪ uncommitted. |
| `--dry-run` | boolean | `false` | Audit only: write artifacts + print findings, open no PR. Local-only — needs no GitHub App creds. |
| `--out <dir>` | string | `.ai-review/` | Directory for the JSON/MD artifacts. |
| `--extra <text>` | string | `""` | Extra instructions appended to every agent's prompt (parity with today's `--extra`). |
| `--json` | boolean | `false` | Emit a machine-readable result (incl. `pr`, `url`, `artifacts`, counts) to stdout instead of human text. |

**`ai-review ready [pr#]`** — retargets the audit PR's base from the orphan branch to the default branch and marks it ready for review (the draft→live transition). `pr#` is optional and defaults to the PR from the last `audit` run (read from `.ai-review/audit.json` `meta.pr`, falling back to the open PR whose head is the current `ai-review/audit-*` branch).

**Defaults, not flags.** `audit` is always local — remote audits stay on the legacy flat `ai-review OWNER/REPO` (slated for deprecation). Changed-only is the default (`--full` opts in). The draft PR opens by default (`--dry-run` opts out). **Both provider passes always run** — no `--provider` flag, since re-reviews surface from both bots regardless and a single-provider audit would read inconsistently. No `--base` flag on either subcommand — the default branch is always the reference.

**Encapsulation.** `ready` is a real subcommand (not raw `gh`) so the orphan→default-branch retarget, the un-draft, and default-PR resolution live in the tool. Manual GitHub-UI finalize (change the base dropdown + click "Ready for review") remains an always-available fallback.

**Lazy auth:** `audit --dry-run` needs only `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`; GitHub App credentials are resolved only when the PR path (or its issue fallback) runs. The PR path posts two reviews, so it authenticates as **both** apps. There is no `--issue` flag — the `Code Audit Report` issue exists only as the automatic fallback when the PR path can't run (see Error handling).

### Two-provider model

Both the Claude pass and the Codex pass run **locally** before the PR opens, and post as **two separate review objects** on the same PR — one as `ai-review-bot`, one as `codex-review-bot` — mirroring today's two-bot UX. The CLI authenticates as **both** GitHub Apps (credentials already exist via `getConfig()` and `getOpenAIAppConfig()` in [src/config.ts](../../../src/config.ts)).

The **head branch must contain every file referenced by either pass**, or diff-anchor validation drops the other provider's comments. In `changed` mode both passes review the same set, so this is automatic; in `--full` mode the head is scoped to the **union of files with ≥1 finding** to keep it minimal.

### Head-branch construction

`createHeadBranch()` cuts `ai-review/audit-<timestamp>` from the default branch's tip, then applies a single commit capturing the **current local working-tree content** of the in-scope files — so uncommitted edits are what gets reviewed and fixed. Files unchanged vs the default branch are already present via its tree (and still render as full additions against the orphan base).

---

## Data flow

```text
1. ai-review audit                  (the plugin command wraps this)
2. collectFilesFromLocal()  → in-scope set (changed ∪ uncommitted, code only)
3. For each provider [anthropic, openai]:
     runAuditPass(files) → Promise.allSettled(TIER1) → mergeReviews → ModelReview
4. Write artifacts: .ai-review/audit-anthropic.json, audit-openai.json, audit.md
   + inject combined findings into agent context
5. ensureOrphanBase("ai-review/empty")
6. createHeadBranch("ai-review/audit-<ts>")  ← commit current local content of in-scope files
7. openDraftPr(base=ai-review/empty, head=ai-review/audit-<ts>) + apply "AI audit" label
8. postProviderReview(claude) as ai-review-bot
   postProviderReview(codex)  as codex-review-bot   (both vs full-file orphan diff)
   → record meta.pr; audit prints the PR URL
9. DRAFT PHASE: agent reads the inline comments (gh api .../comments) and applies
   first-pass fixes on the head branch. (No webhook re-reviews fire — the PR is a
   draft, so the apps skip it. The agent works off the initial inline comments.)
10. ai-review ready                 (retarget base→default branch + un-draft)
11. → /pr-loop <n>: now a normal ready PR. Webhook apps + external bots
    re-review the small fixes-only diff and drive to approval.
```

**Ordering note:** the `ready` transition happens *before* `/pr-loop`'s loop, not after. While the PR is a draft against the orphan base, the webhook apps skip it, so no automated re-reviews occur — the agent consumes the *initial* inline comments during the draft phase. `ready` is the gate that turns the PR live, after which `/pr-loop`'s normal re-review polling fires on every push.

**`AI audit` label.** Applied at PR-open so review bots (ours and external) can detect AI-audit-initiated PRs and treat them differently in future. Framework only — no differential behavior is wired yet.

### Bot-storm & cost control

Opening a PR wakes every PR-triggered bot. On the full-file orphan diff, external bots with line/file limits would refuse or burn tokens. We avoid this entirely:

1. **Draft PR + direct posting.** Our webhook apps skip drafts, so they never re-review the big diff — findings were already computed locally, so we never pay twice. Draft-skipping external bots stay silent. The full-file diff is never sent to any reviewer.
2. **Scope the head** to the in-scope/union file set, never the whole tree.
3. **`ready` only at the end.** The diff collapses to the small fixes-only set — that is when CodeRabbit and the webhook bots review and add their (good) findings, on a diff small enough to accept. Every subsequent push re-reviews only the incremental delta, so cost stays bounded.

> External bots cannot review the whole-file audit stage itself (size limits), so audit-stage inline review is necessarily our own two bots only. External bots contribute on the fixes round, which is the right place for them.

---

## Error handling & fallback

- **Per-agent failure** → existing `Promise.allSettled` in `runAgent`; one agent dying never aborts a pass.
- **One provider fails entirely** → still post the other provider's review; log the gap. Degraded, not dead.
- **Invalid inline anchors** → existing `buildReviewComments` drops and logs them. On a full-file orphan diff essentially all lines are valid, so drops are rare.
- **Empty findings** → if both providers find nothing, skip PR creation; write artifacts and report "clean" to context. No empty PR.
- **Missing `contents: write` scope** → branch/commit/PR calls 403. Catch the 403 on the first write, skip the PR path, and **fall back to local artifacts (always written) + an idempotent `Code Audit Report` issue** (reuse `POST .../issues`, find-or-update). Clear log line explains why. The engine + artifacts are fully functional with zero new permissions; the PR experience is a strict upgrade that lights up once the scope is granted.

### Lifecycle

Each run opens a **fresh timestamped PR + head branch**. On close/merge the head branch is **auto-deleted**; the orphan `ai-review/empty` base is created once and reused.

---

## Security considerations

- **New GitHub App scope: `contents: write`** on both apps (branch/ref creation + commit the orphan tree). `pull_requests: write` is already granted (the apps post reviews today). Setup steps in the Rollout section.
- `src/audit-pr.ts` performs all the new writes and must pass `security-review` (it constructs refs, commits, and PRs from repo-derived input).
- The CLI handles **two** App private keys locally; document that local audits opening a PR require both apps' credentials in the environment.

---

## Testing

Vitest, colocated, reusing `src/testing.ts` fixtures; no real skill files mocked (per project convention).

| Test file | Covers |
|---|---|
| `src/sources.test.ts` *(new)* | `changed` = `git diff` ∪ uncommitted; code-extension filtering; `--full` = `git ls-files`. Git stubbed via the injectable runner. |
| `src/audit.test.ts` *(new — none today)* | Both-provider orchestration (two `ModelReview`s); one-provider-fails-still-posts-other; empty-findings-skips-PR; `--dry-run` writes artifacts + opens no PR; untruncated artifact JSON shape. Uses `buildModelReview` / `buildGenerateObjectResponse`. |
| `src/audit-pr.test.ts` *(new)* | Orphan-base diff → all lines valid for `buildReviewComments`; two-identity review posting; `AI audit` label applied; `makeReady()` retargets base→default branch + un-drafts; **403-on-write → fallback to artifact + issue**. Octokit stubbed via existing `OctokitLike` shape. |

Existing `github-app.test.ts` already covers the `ready_for_review`/`synchronize` re-review that fires once the PR goes live.

**Quality gates** (per CLAUDE.md): `npm run typecheck && npm run lint && npm run test` all green before PR.

---

## Rollout / build order

1. **Refactor** `audit.ts`: extract `collectFilesFromGitHub()` + `runAuditPass()`; no behavior change.
2. **Local source + artifacts:** `src/sources.ts`, `formatAuditJson()`, artifact writer; CLI `audit` subcommand with `--full/--dry-run/--out/--extra/--json`; lazy auth; add `.ai-review/` to `.gitignore`.
3. **Review-PR machinery:** `src/audit-pr.ts` (orphan base, head branch, draft PR + `AI audit` label, two-identity reviews, `makeReady()`); the `audit` PR path (default) and the `ready` subcommand; the 403 → issue fallback.
4. **Plugin command** *(deferred — own pass):* orchestrates audit → first-pass fix → `ai-review ready` → `/pr-loop`. Ships as part of the **AI Review** Claude Code plugin (commands carry the `AI Review:` prefix).
5. **Tests** across all three new test files; green quality gates.

### GitHub App permission setup (manual — Joe)

The only **new** permission is **`contents: write`**. For **each** app (Claude and Codex):

1. github.com/settings/apps → app → **Permissions & events**.
2. **Repository permissions → Contents → Read & write**.
3. Verify **Pull requests → Read & write** is present (it should be).
4. **Save changes**.
5. **Approve the upgraded permissions for each installation** — until this is done the new scope 403s. At **github.com/settings/installations** (or **github.com/organizations/&lt;org&gt;/settings/installations** for org installs), click **Configure** on each app and accept the *"requesting updated permissions"* banner (GitHub also emails the owner an approval link). If no banner appears, the grant already applied; verify Contents shows "Read & write" at github.com/settings/apps/&lt;app-slug&gt;/permissions.

If the apps are defined by a manifest in this repo, bump `default_permissions.contents` there too.

---

## Verification

- **Local artifact:** in a scratch repo with an uncommitted bug, `ai-review audit --dry-run --out /tmp/aud`; confirm `audit-*.json` is untruncated and reflects the uncommitted change; confirm `--full` vs default (changed) differ.
- **No-auth path:** unset `GITHUB_APP_ID`; confirm `audit --dry-run` runs on the AI keys alone.
- **Orphan-base PR:** on a throwaway repo, `ai-review audit` → confirm the PR diff shows whole files as additions, the `AI audit` label is set, and inline comments post on arbitrary lines; then `ai-review ready` → confirm the diff collapses to fixes-only, stale comments mark outdated, and the PR merges with no synthetic content in the default branch's history.
- **Fallback:** with `contents: write` absent, confirm the 403 is caught and the run degrades to artifact + idempotent issue.
- **Re-review loop:** confirm the existing webhook posts a diff-scoped review after `ready` + a push.

---

## Open items / follow-ups

- **Plugin packaging + slash commands** — the project becomes a Claude Code plugin named **AI Review** (commands get the `AI Review:` prefix). The orchestration command(s) wrapping `audit`/`ready`/`/pr-loop` are designed in a dedicated pass after the CLI lands.
- **pr-loop rewrite** — the developer-agent ↔ reviewer-agent communication flow in [pr-loop.md](file:///Users/joe/.claude/commands/pr-loop.md) needs an optimization pass (polling cadence, reply/resolve mechanics, draft handling). Tracked as its own beads issue; gets its own design pass, not a bolt-on.

---

## Alternatives considered

- **A — Local artifact only (`--dry-run`):** smallest build, lossless for an agent, but no human/CI surface and no inline-review UX. **Survives as a sub-component** (the JSON artifact is one output sink, and `--dry-run` is its mode).
- **C alone — command + idempotent issue, no PR:** good agent ergonomics with zero new scopes, but findings live in a lossy issue rather than actionable inline comments; loses the `/pr-loop` integration. Rejected as the primary surface; its issue path survives as the **403 fallback**.
- **Chosen — local-tree audit surfaced as a synthetic-base review PR:** engine + ergonomics (local audit, in-context findings) plus a durable, inline, `/pr-loop`-native PR, with `ready` retargeting for clean merges. Costs the new `contents: write` scope, justified by the inline-review experience.
