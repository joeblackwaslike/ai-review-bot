# Design Spec — `ai-review watch`: Local, Subscription-Auth PR Re-Review Loop

**Date:** 2026-08-16
**Status:** Approved design, pre-implementation
**Author:** Joe Black (with Claude)

---

## Context

The hosted webhook bots (`anthropicreviewbot`, `codexreviewbot`) require funded `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` balance — [src/models.ts:36-44](../../../src/models.ts#L36-L44), [src/auth.ts:4-9](../../../src/auth.ts#L4-L9). With no API balance and no money to add, Joe needs a way to keep getting constructive review on his own PRs while driving them through `/pr-loop`, using his existing Claude Max and ChatGPT Pro subscriptions instead.

`src/auth.ts` already resolves subscription/OAuth auth locally (`resolveAnthropicAuth()` at [src/auth.ts:473-519](../../../src/auth.ts#L473-L519), `resolveOpenAIAuth()` at [src/auth.ts:412-471](../../../src/auth.ts#L412-L471)) — verified working end-to-end in this session (`ai-review review --commit <sha>` produced a real finding via `claude-sonnet-4-6` with both API keys unset). But that resolver is explicitly restricted to CLI/local invocation — the module-level comment at [src/auth.ts:4-9](../../../src/auth.ts#L4-L9) states Anthropic's ToS (eff. 2026-02-20) prohibits using subscription OAuth tokens in third-party/automated tools, and forbids importing this module from the hosted webhook/Vercel paths. That restriction targets an *unattended service posting to arbitrary repos*, not a developer manually running a tool against their own PR one at a time — the exact usage pattern `ai-review audit`/`review` already exercise locally.

Two structural gaps prevent reusing today's CLI for the "drive one of my own open PRs" case:

1. `ai-review review`/`audit` operate on local file content (working tree, a commit, or a synthetic orphan-base PR) — none of them attach a review to an **already-open, normally-branched PR** the way the webhook bots do.
2. Nothing in the CLI polls a PR for new pushes and re-reviews it — that behavior only exists in the webhook-triggered `runScheduledReview()` path ([src/github-app.ts:727-833](../../../src/github-app.ts#L727-L833)).

Separately, this session found `src/router.ts:81-83`'s `OPENAI_TIER_MAP` hardcodes `gpt-5.1` for the trivial/normal/complex tiers, which the ChatGPT/Codex-account backend now rejects (`"The 'gpt-5.1' model is not supported when using Codex with a ChatGPT account"` — confirmed live against Joe's account; the account's live model catalog no longer includes it). This blocks cross-provider subscription auth today regardless of this feature, and is a prerequisite fix.

## Goals

- A local CLI command that reviews an **already-open PR** (one Joe is actively driving), posts a real GitHub PR review using subscription auth for the model calls.
- Reviews post under the **same GitHub App bot identities** production uses (`anthropicreviewbot`/`codexreviewbot`) — not Joe's personal account — so the existing reaction/reply-mining pipeline (`findUnratedFindings`, QC judging, reviewer-memory `survivingPrior`) keeps working unmodified, and comments don't read as the implementer talking to themselves.
- Re-reviews automatically on new pushes (head-SHA change), polling — no webhook/QStash required.
- Auto-exits when the PR merges or closes.
- Both providers by default (matching production dual-bot UX), narrowable via a flag.
- Fix the stale `gpt-5.1` Codex model constant so OpenAI subscription auth actually works.

## Non-goals

- No change to the hosted webhook bots or their auth (they stay API-key-only, per [src/auth.ts:4-9](../../../src/auth.ts#L4-L9) — not up for revisiting).
- No new peer-bot coalescing/wait logic (`shouldRunNow`) — that's specific to the QStash-scheduled path and actively unwanted for an interactive local loop where Joe wants his review promptly.
- No daemon/pidfile management inside the CLI itself. Backgrounding (`ai-review watch --pr 123 &`) is the caller's job (`/pr-loop`, or Joe's shell) via standard job control.
- No auto-start from `/pr-loop` by default — running `watch` alongside funded hosted bots would just double-post. It's an opt-in step for the no-balance case.

---

## Architecture

### Approaches considered

**A — Thread `auth` into the existing manual-trigger path, drive with a local poll loop. (Chosen.)**
`maybeSubmitReview()` ([src/github-app.ts:248-269](../../../src/github-app.ts#L248-L269)) is already the function the production `/ai-review` slash command calls for an immediate, non-delayed review (`issue_comment.created → parseReviewCommand() → maybeSubmitReview()`, per `CLAUDE.md`'s Request flow) — it bypasses `runScheduledReview`'s QStash peer-wait/coalescing entirely. `buildReview()` underneath already gives dedupe (`dedupeClaims`, [src/review.ts:515,524](../../../src/review.ts#L515)) and reviewer-memory/`survivingPrior` provenance ([src/review.ts:968-1096](../../../src/review.ts#L968-L1096), [src/review.ts:1006-1016](../../../src/review.ts#L1006-L1016)) "for free" — none of that needs reimplementing. The only gap: `maybeSubmitReview` → `buildReview` → `runAgent` doesn't currently accept an `auth` param end-to-end, even though `runAgent` already supports one — `src/audit.ts:97,123` shows the exact pattern to copy (`runAgent(skill, userMessage, selection, extraInstructions, { auth })`).

**B — Reuse `runScheduledReview()`, synthesizing a `ReviewRunMessage` each poll tick.** More "one shared path," but `runScheduledReview` carries the webhook-specific peer-bot coalescing gate (`shouldRunNow`, waiting for CodeRabbit etc.) that fights a local interactive loop. Rejected.

**C — Bespoke posting logic, no reuse of `maybeSubmitReview`.** Duplicates retry/fallback/dedupe/memory logic that's already correct, risks drift from production. Rejected.

### Components

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| **Auth threading** | `src/review.ts`, `src/github-app.ts` *(modify)* | Add optional `auth?: ResolvedAuth` to `ReviewContext` ([src/review.ts:39-67](../../../src/review.ts#L39-L67)) and to `maybeSubmitReview`'s params ([src/github-app.ts:248](../../../src/github-app.ts#L248)); pass through to the existing `runAgent(..., { auth })` call site ([src/review.ts:1170](../../../src/review.ts#L1170)). Production webhook callers keep omitting it — unchanged behavior (still falls back to env-var API keys, [src/models.ts:36-44](../../../src/models.ts#L36-L44)). |  |
| **Installation resolver** | `src/improve/octokit.ts` *(extend)* | Existing `installationOctokit(appId, privateKey, owner, repo)` ([src/improve/octokit.ts:6-21](../../../src/improve/octokit.ts#L6-L21)) returns only an installation-scoped Octokit. `maybeSubmitReview` needs `{app, installationId}`. Add a sibling helper (or an options flag) that also returns the `App` instance + resolved `installationId`, reusing the same `GET /repos/{owner}/{repo}/installation` lookup already used by `src/audit.ts:164-168` and `src/cli.ts`'s `buildResolvePr()`. | `App` (octokit), GitHub App creds |
| **Watch driver** | `src/watch.ts` *(new)* | `watchPr({owner, repo, pullNumber, providers, intervalSeconds})`: polls `GET /repos/{o}/{r}/pulls/{n}`; exits when `merged`/`state === "closed"`; per provider, on first run or `head.sha` change (relative to that provider's own last-reviewed SHA), resolves subscription auth and calls `maybeSubmitReview({..., auth, force})` (`force` is `true` only until *that provider's* first successful post — see Error handling below); logs outcome; only advances *that provider's* remembered last-reviewed SHA once it actually posted. State is per-provider throughout, not session-wide. | `resolveAnthropicSubscriptionAuth`, `resolveOpenAISubscriptionAuth`, `maybeSubmitReview`, installation resolver |
| **CLI surface** | `src/cli.ts` *(extend)* | New `ai-review watch --pr <n> [--repo <owner/name>] [--provider anthropic\|openai] [--interval <seconds>]` subcommand. Repo defaults from `originSlug()` ([src/cli.ts:121-134](../../../src/cli.ts#L121-L134)) same as `audit`/`ready`. Wires `resolveSubscriptionAuth` (not the api-key-first `resolveAuth`) as `watchPr`'s `resolveAuthFor` — a stray `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the environment must never silently defeat watch's whole reason for existing. Found live 2026-08-18 dogfooding this PR: the first watch launch reused the hosted webhook's own exhausted `ANTHROPIC_API_KEY` from `.env` instead of falling back to the logged-in `claude` session. | `watchPr`, `originSlug`, `resolveSubscriptionAuth` |
| **Model constant fix** | `src/router.ts` *(fix)*, `src/models.ts` *(fix)* | Swap the stale `gpt-5.1` entries in `OPENAI_TIER_MAP` for a model the ChatGPT/Codex-account backend currently accepts. As-built, this is auth-mode-branched, not universal: API-key callers keep `gpt-5.1` (confirmed working in production; the rejection was only ever observed against the OAuth/ChatGPT-account backend) via `OPENAI_TIER_MAP_API_KEY`, while OAuth/subscription callers move to `gpt-5.4` via a separate `OPENAI_TIER_MAP_OAUTH` ([src/router.ts:82-110](../../../src/router.ts#L82-L110)), selected by `routeModel`'s `authMode` param. `triageReReview`'s own model selection (`src/triage.ts`) mirrors the same branch. The matching `TOKEN_RATES` entries live in `src/models.ts`. | — |

### CLI surface

**`ai-review watch --pr <n> [options]`**

| Option | Type | Default | Description |
|---|---|---|---|
| `--pr <n>` | number | *(required)* | PR number to watch. |
| `--repo <owner/name>` | string | from `git remote get-url origin` (`originSlug()`) | Target repo. |
| `--provider <anthropic\|openai>` | string | both | Narrow to a single provider. |
| `--interval <seconds>` | number | `300` (changed from `60` — see `ai-review-bot-599` follow-up) | Poll interval. |
| `--json` | boolean | `false` | Machine-readable per-cycle output, matching existing CLI convention. |

Auth is always resolved via `resolveAnthropicAuth()`/`resolveOpenAIAuth()` — no API-key mode for this command; if someone wants API-key-funded automatic review, that's what the hosted webhook bots are for.

---

## Data flow

```text
1. ai-review watch --pr 123
2. originSlug() or --repo → {owner, repo}
3. Resolve GitHub App creds for selected provider(s) (getConfig() / getOpenAIAppConfig(),
   same as `audit`/`ready` already require)
4. Resolve subscription auth per provider (resolveAnthropicAuth / resolveOpenAIAuth) —
   fails fast with the existing "run `claude`/`codex login`" error if not logged in
5. loop:
   a. GET /repos/{owner}/{repo}/pulls/{n}
   b. if merged || state === "closed": log + exit 0
   c. for each selected provider (state tracked per provider, not session-wide — see Error handling):
        if head.sha === providerState[provider].lastReviewedSha: continue to next provider
        installation = resolve {app, installationId} for that provider's App
        maybeSubmitReview({ app, installationId, owner, repo, pullNumber: n,
                             pullRequest: data, extraInstructions: "",
                             force: !providerState[provider].hasPostedEver, config, auth })
        → buildReview() → runAgent(..., {auth}) per Tier1(+Tier2) skill
        → dedupeClaims / survivingPrior applied automatically inside buildReview
          (only on cycles after that provider's first post — see Error handling)
        → posts review as {provider}reviewbot via the installation octokit
        → if status "posted": providerState[provider].hasPostedEver = true;
          providerState[provider].lastReviewedSha = data.head.sha
   d. sleep(interval)
```

---

## Error handling

- **Transient poll failure** (network blip, 5xx) — log, continue to next interval. Do not exit.
- **Subscription auth expired/logged out mid-watch** — surface `src/auth.ts`'s existing descriptive error (`"run `claude` to log in"` / `"run `codex login`"`) and exit non-zero. No silent hang, no fallback to API keys (there may be none funded).
- **GitHub rate-limit response** — back off using the poll interval rather than hot-looping; log the reset time if present in headers.
- **One provider fails, other succeeds** — same as production: `Promise.allSettled` inside `runAgent`/`buildReview` means a single agent dying never aborts the pass; if a whole provider's pass fails, log and continue watching (don't exit the loop over one bad cycle).
- **`force` semantics** — `!providerState[provider].hasPostedEver` (see data flow), not unconditional `true`, and not a single session-wide flag shared across providers. The manual `/ai-review` slash command's `force: true` skips peer-bot wait *and* the reviewer-memory/triage gate on every invocation, which is correct for a one-shot manual re-review — but `watch` runs repeatedly and unattended, so unconditional `force` would disable the triage gate and reviewer-memory (`survivingPrior`) on every cycle and let each forced write overwrite persisted state. Only the very first post (no prior state to preserve, no existing marker to conflict with) needs `force`; every cycle after that behaves exactly like a normal push-triggered production review — the "indistinguishable from production" goal (Goals, above) depends on this, not just on the identity match. Found during a final whole-feature review after initial implementation with unconditional `force: true`; the code was fixed, this section originally wasn't.
- **`hasPostedEver`/`lastReviewedSha` must be per-provider, not session-wide** — a single shared pair leaks across providers: provider B's genuinely-first post would inherit `force: false` merely because provider A posted first (same cycle or an earlier one), breaking the "first post is unforced-equivalent" parity above for B; and if A posts successfully while B fails/skips in the same cycle, a shared `lastReviewedSha` advances anyway, permanently denying B a retry on that commit (it only gets reviewed again if the PR receives a new push). Surfaced by anthropicreviewbot's own re-review while dogfooding `watch` on this PR; fixed by keying both fields per provider (a `Map<Provider, {hasPostedEver, lastReviewedSha}>`).

---

## Security considerations

- Requires the same GitHub App credentials (`GITHUB_APP_ID`/`PRIVATE_KEY`, `OPENAI_APP_ID`/`PRIVATE_KEY`) `ai-review audit` already requires locally — no new scope needed (`pull_requests: write` already granted for review posting).
- Subscription credentials (macOS Keychain, `~/.codex/auth.json`) never leave the local machine — same as today's CLI path; nothing new posted or transmitted beyond what `resolveAnthropicAuth`/`resolveOpenAIAuth` already do.
- No change to what gets posted publicly vs. today's bots — same identities, same review content shape.

---

## Testing

Vitest, colocated, reusing `src/testing.ts` fixtures; no real skill files mocked (per project convention). TDD per project convention — red before green on each.

| Test file | Covers |
|---|---|
| `src/review.test.ts` *(extend)* | `buildReview`/`maybeSubmitReview` pass `auth` through to `runAgent` when provided; omitted `auth` still falls back to env-var keys (no regression to webhook callers). |
| `src/watch.test.ts` *(new)* | Poll loop: no post when `head.sha` unchanged; posts once per provider on SHA change; exits on `merged`/`closed`; continues past a single transient fetch failure; surfaces the auth-resolution error and exits on subscription-login failure. Octokit stubbed via existing `OctokitLike` shape; interval/sleep injected so tests don't need real timers. |
| `src/router.test.ts` *(extend)* | `OPENAI_TIER_MAP` no longer produces `gpt-5.1`; deep tier unaffected. |

**Quality gates** (per CLAUDE.md): `npm run typecheck && npm run lint && npm run test` all green before commit.

---

## Rollout / build order

1. **Model constant fix** (`src/router.ts`, `src/models.ts`) — smallest, independent, unblocks OpenAI subscription auth immediately regardless of the rest.
2. **Auth threading** — `ReviewContext`/`maybeSubmitReview` optional `auth` param, plumbed to the existing `runAgent` call site. No behavior change for existing callers.
3. **Installation resolver extension** — `src/improve/octokit.ts` sibling helper returning `{app, installationId}`.
4. **`src/watch.ts`** — poll loop, provider selection, exit conditions.
5. **CLI subcommand** — `ai-review watch` wired into `src/cli.ts`, following the existing flag-parsing conventions (`audit`/`ready`).
6. **Tests** across all three touched/new test files; green quality gates.

### Follow-on documentation (separate, docs-only — no plan needed, done directly after this ships)

Both live outside this repo:

1. `agent-skills`' `skills/working-with-github/references/howto/driving-a-pr-to-approval.md` — new section: when API balance is unavailable, run `ai-review watch --pr <n> &` before driving the PR; reviews land under the same bot identities so the runbook's existing reviewer-polling/thread logic needs no changes.
2. `agent-harness`'s `commands/pr-loop.md` — an opt-in step to start `ai-review watch --pr <n>` in the background per PR, explicitly not automatic/default (would double-post against funded hosted bots).

---

## Verification

- **Auth threading:** with both API keys unset and subscription logged in, `maybeSubmitReview({..., auth})` on a real PR produces a review identical in shape to a normal bot review, posted as the bot identity (confirm via `gh pr view <n> --json reviews` showing `anthropicreviewbot`/`codexreviewbot` as author).
- **Poll → re-review:** push a new commit to a watched PR; confirm a second review posts within one interval, and that reviewer-memory/dedup behaves the same as the webhook path (no restated findings for unchanged issues).
- **Auto-exit:** merge or close the watched PR; confirm the process exits within one poll cycle.
- **Cross-provider:** confirm both `anthropicreviewbot` and `codexreviewbot` post successfully post-model-fix (currently the OpenAI side 400s on `gpt-5.1`).
- **`/pr-loop` compatibility:** drive a real PR end-to-end with `watch` running in the background; confirm `/pr-loop`'s existing reviewer-detection/thread-reply logic needs zero changes.

---

## Open items / follow-ups

- Companion doc updates (above) — tracked as follow-on work in `agent-skills` and `agent-harness`, not part of this repo's plan.
- Whether `watch` should eventually support the same `REVIEW_AGENT_BUDGET_SECONDS` partial-review safety net as the hosted path — deferred; today's manual `/ai-review` slash-command path (which `watch` mirrors) doesn't have this either, so no regression.

---

## Alternatives considered

- **B — reuse `runScheduledReview()` with a synthesized message:** rejected — the peer-bot coalescing gate fights an interactive local loop.
- **C — bespoke posting logic:** rejected — duplicates already-correct retry/fallback/dedupe/memory behavior, risks drift.
- **Meridian (rynfar/meridian) or similar OAuth-bridging proxy:** rejected as an unnecessary extra hop — `src/auth.ts` already resolves subscription auth directly, and routing through a third-party proxy doesn't change the underlying ToS analysis (which is about usage pattern, not OAuth-extraction mechanism).
