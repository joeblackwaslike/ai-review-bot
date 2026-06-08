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
- Deliver findings into a coding agent's context via a **Claude Code slash command** for immediate action.
- Persist findings as a **real GitHub PR review with inline comments**, drivable by `/pr-loop` and the existing re-review webhook, serving humans/CI as well as the agent.
- Land fixes on `main` cleanly, with bounded review cost for the rest of the PR's life.

## Non-goals

- No change to the existing webhook PR-review behavior (it already handles re-review).
- No agentic auto-fixing inside the CLI — the CLI surfaces findings; `/pr-loop` (or the human) implements fixes.
- No support for non-Claude-Code agent front-ends in v1 (the underlying CLI stays portable for CI/humans).

---

## Architecture

### The core mechanism: orphan base + base-retarget

GitHub PR diffs are **three-dot** (`merge-base(base, head)..head`). An unchanged line is only commentable inline if the file differs between the merge-base and head. An audit changes nothing vs `main`, so there is no diff to comment on — the wall.

**Escape:** base the audit PR on an **orphan branch** with no shared history. `merge-base = ∅`, so the diff renders the **entire head tree as additions** — every line is a valid RIGHT-side line, so any finding can be posted as an inline comment. This reuses `collectRightSideLines()` / `buildReviewComments()` ([src/review.ts:276](../../../src/review.ts#L276), [src/review.ts:325](../../../src/review.ts#L325)) unchanged.

**Clean merge:** the head branch is cut from `main`, so it is literally `main + [fix commits]`. After `/pr-loop` applies fixes, **`PATCH /pulls/{n}` retargets base → `main`**. The diff recomputes as `main...head` = only the fixes — an ordinary, mergeable PR. Audit-stage comments on lines the agent didn't touch fall outside the new diff and GitHub auto-marks them **outdated/collapsed**. No synthetic content ever enters `main`'s lineage.

### Components

Each unit has one purpose, a defined interface, and is independently testable.

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| **File sources** | `src/sources.ts` *(new)* | `collectFilesFromLocal({cwd, mode, base})` — `changed` (default) = `git diff --name-only <merge-base main>` ∪ `git status --porcelain` (uncommitted); `full` = `git ls-files`. Filters via `hasCodeExtension`. Reads via `node:fs/promises`. Also houses `collectFilesFromGitHub()` extracted from today's `auditRepo`. Git invoked through a small injectable runner so tests stub output. | `git`, `hasCodeExtension` |
| **Audit core** | `src/audit.ts` *(refactor)* | `runAuditPass({files, provider, extraInstructions})` → `TIER1_SKILLS` via `runAgent` → `mergeReviews` → one `ModelReview`. Orchestrator runs it for **both** providers. `auditRepo()` stays as the thin remote entry. | `runAgent`, `mergeReviews`, `routeModel`, `TIER1_SKILLS` |
| **Artifact writer** | `src/audit.ts` | Writes `.ai-review/audit-<provider>.json` (untruncated `{meta, review}`) + combined `audit.md` (task-list + `path:line` anchors). | `node:fs/promises` |
| **Review-PR machinery** | `src/audit-pr.ts` *(new)* | `ensureOrphanBase()`, `createHeadBranch()`, `openDraftPr()`, `postProviderReview()` (×2 identities), `retargetToMain()`. | Octokit (both App identities), `buildReviewComments` |
| **Slash command** | `.claude/commands/ai-audit.md` *(new)* | Runs `ai-review audit --local --changed`, injects findings into context, opens the draft PR, hands off to `/pr-loop`. | the CLI |

### CLI surface (light subcommands, backward-compatible)

- `ai-review audit [OWNER/REPO] [--local] [--changed | --full] [--out <dir>] [--pr | --no-pr]` — runs the audit; `--pr` opens the draft review PR.
- `ai-review finalize <pr#>` — retargets base→`main` and marks the PR ready (post-fix step).
- Existing `ai-review OWNER/REPO` remote behavior is preserved.
- **Lazy auth:** a pure local audit (`--no-pr`) needs only `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`; GitHub App credentials are resolved only when the PR path (or its issue fallback) runs.

There is no separate `--issue` flag — the `Code Audit Report` issue exists only as the automatic fallback when the PR path can't run (see Error handling).

### Two-provider model

The bot runs **both** a Claude pass and a Codex pass. Both run **locally** before the PR opens, and post as **two separate review objects** on the same PR — one as the `ai-review-bot` identity, one as `codex-review-bot` — mirroring today's two-bot UX. The CLI therefore authenticates as **both** GitHub Apps (credentials already exist via `getConfig()` and `getOpenAIAppConfig()` in [src/config.ts](../../../src/config.ts)).

The **head branch must contain every file referenced by either pass**, or diff-anchor validation drops the other provider's comments. In `--changed` mode both passes review the same changed set, so this is automatic; in `--full` mode the head is scoped to the **union of files with ≥1 finding** to keep it minimal.

### Head-branch construction

`createHeadBranch()` cuts `ai-review/audit-<timestamp>` from `main`'s tip, then applies a single commit capturing the **current local working-tree content** of the in-scope files — so uncommitted edits are what gets reviewed and fixed. Files unchanged vs `main` are already present via `main`'s tree (and still render as full additions against the orphan base).

---

## Data flow

```
1. /ai-audit  (or `ai-review audit --local --changed --pr`)
2. collectFilesFromLocal()  → in-scope set (changed ∪ uncommitted, code only)
3. For each provider [anthropic, openai]:
     runAuditPass(files) → Promise.allSettled(TIER1) → mergeReviews → ModelReview
4. Write artifacts: .ai-review/audit-anthropic.json, audit-openai.json, audit.md
   + inject combined findings into agent context (slash command)
5. ensureOrphanBase("ai-review/empty")
6. createHeadBranch("ai-review/audit-<ts>")  ← commit current local content of in-scope files
7. openDraftPr(base=ai-review/empty, head=ai-review/audit-<ts>)
8. postProviderReview(claude) as ai-review-bot
   postProviderReview(codex)  as codex-review-bot   (both vs full-file orphan diff)
9. → /pr-loop: agent reads both reviews, commits fixes to head
10. ai-review finalize <pr#>: retargetToMain() + mark ready
11. → ecosystem (CodeRabbit + webhook apps) re-review the small fixes-only diff
```

### Bot-storm & cost control

Opening a PR wakes every PR-triggered bot. On the full-file orphan diff, external bots with line/file limits would refuse or burn tokens. We avoid this entirely:

1. **Draft PR + direct posting.** Our webhook apps skip drafts (existing draft guard), so they never re-review the big diff — findings were already computed locally, so we never pay twice. Draft-skipping external bots stay silent. The full-file diff is never sent to any reviewer.
2. **Scope the head** to the in-scope/union file set, never the whole tree.
3. **Retarget + mark ready only at the end.** The diff collapses to the small fixes-only set — that is when CodeRabbit and the webhook bots review and add their (good) findings, on a diff small enough to accept. Every subsequent push re-reviews only the incremental delta, so cost stays bounded.

> Note: external bots cannot review the whole-file audit stage itself (size limits), so audit-stage inline review is necessarily our own two bots only. This is acceptable — external bots contribute on the fixes round, which is the right place for them.

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
- The CLI handles **two** App private keys locally; document that local audits with `--pr` require both apps' credentials in the environment.

---

## Testing

Vitest, colocated, reusing `src/testing.ts` fixtures; no real skill files mocked (per project convention).

| Test file | Covers |
|---|---|
| `src/sources.test.ts` *(new)* | `--changed` = `git diff` ∪ uncommitted; code-extension filtering; `--full` = `git ls-files`. Git stubbed via the injectable runner. |
| `src/audit.test.ts` *(new — none today)* | Both-provider orchestration (two `ModelReview`s); one-provider-fails-still-posts-other; empty-findings-skips-PR; untruncated artifact JSON shape. Uses `buildModelReview` / `buildGenerateObjectResponse`. |
| `src/audit-pr.test.ts` *(new)* | Orphan-base diff → all lines valid for `buildReviewComments`; two-identity review posting; `retargetToMain` produces fixes-only diff; **403-on-write → fallback to artifact + issue**. Octokit stubbed via existing `OctokitLike` shape. |

Existing `github-app.test.ts` already covers the `synchronize` re-review that fires post-finalize.

**Quality gates** (per CLAUDE.md): `npm run typecheck && npm run lint && npm run test` all green before PR.

---

## Rollout / build order

1. **Refactor** `audit.ts`: extract `collectFilesFromGitHub()` + `runAuditPass()`; no behavior change.
2. **Local source + artifacts:** `src/sources.ts`, `formatAuditJson()`, artifact writer; CLI `audit` subcommand with `--local/--changed/--full/--out`; lazy auth; add `.ai-review/` to `.gitignore`.
3. **Review-PR machinery:** `src/audit-pr.ts` (orphan base, head branch, draft PR, two-identity reviews, retarget); `ai-review finalize` subcommand; the 403 → issue fallback.
4. **Slash command:** `.claude/commands/ai-audit.md`; optional marketplace publish.
5. **Tests** across all three new test files; green quality gates.

### GitHub App permission setup (manual — Joe)

The only **new** permission is **`contents: write`**. For **each** app (Claude and Codex):

1. github.com/settings/apps → app → **Permissions & events**.
2. **Repository permissions → Contents → Read & write**.
3. Verify **Pull requests → Read & write** is present (it should be).
4. **Save changes**.
5. Approve the upgraded permissions for each installation (banner/email at github.com/settings/installations or org → GitHub Apps), or the writes will 403.

If the apps are defined by a manifest in this repo, bump `default_permissions.contents` there too.

---

## Verification

- **Local artifact:** in a scratch repo with an uncommitted bug, `ai-review audit --local --changed --out /tmp/aud`; confirm `audit-*.json` is untruncated and reflects the uncommitted change; confirm `--changed` vs `--full` differ.
- **No-auth path:** unset `GITHUB_APP_ID`; confirm `--local --no-pr` runs on the AI keys alone.
- **Orphan-base PR:** on a throwaway repo, confirm the PR diff shows whole files as additions and inline comments post on arbitrary lines; `finalize` → confirm the diff collapses to fixes-only, stale comments mark outdated, and the PR merges with no synthetic content in `main`'s history.
- **Fallback:** with `contents: write` absent, confirm the 403 is caught and the run degrades to artifact + idempotent issue.
- **Re-review loop:** confirm the existing `synchronize` webhook posts a diff-scoped review after fixes.

---

## Alternatives considered

- **A — Local artifact only (`--out`):** smallest build, lossless for an agent, but no human/CI surface and no inline-review UX. **Survives as a sub-component** (the JSON artifact is one output sink).
- **C alone — slash command + idempotent issue, no PR:** good agent ergonomics with zero new scopes, but findings live in a lossy issue rather than actionable inline comments; loses the `/pr-loop` integration. Rejected as the primary surface; its issue path survives as the **403 fallback**.
- **Chosen — C feeds B:** local-tree audit via the slash command (engine + ergonomics) surfaced as a synthetic-base review PR (durable, inline, `/pr-loop`-native), with base-retarget for clean merges. Costs the new `contents: write` scope, justified by the inline-review experience.
