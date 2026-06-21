# Feedback → Iterative Improvement Loop — Design Spec

**Status:** Approved (brainstorming) — ready for implementation plan
**Date:** 2026-06-21
**Beads:** `ai-review-bot-x4c` (epic), `ai-review-bot-7fg` (this spec)
**Branch:** `feat/feedback-improvement-loop-spec` (off `main`)
**Builds on:** `docs/superpowers/specs/2026-06-10-inline-feedback-capture-design.md` (the recording-only MVP this extends)

## Goal

Close the loop the inline-feedback MVP left open. Today the bot records 👍/👎 on **inline**
comments into an append-only Upstash KV list and **never reads it**. This spec turns that raw
signal into a **self-improving review system**:

1. **Capture more** — extend reactions to the **top-level review**, and scrape **free-text
   replies/comments** (criticism, praise, "this is a bug in the reviewer"), classified by intent.
2. **Catalog it** — drain everything into a queryable **Neon Postgres** corpus, matched to the
   exact finding it concerns.
3. **See it** — a **dashboard** (Next.js, GitHub-OAuth, Joe-only) showing both what's *degrading*
   and what's *working*.
4. **Act on it** — detect degrading **trends** and fast-path **anomalies**, open **collaborative
   GitHub Issues** that brainstorm a fix into a **spec** before any PR is written.
5. **Proactively QC** — a **dedicated `/qc` GitHub App** re-judges posted findings (on command or
   by random sampling) and posts a QC report comment.
6. **Teach agents** — runbooks in `agent-skills` showing how to give this feedback and where it goes.

The guiding principle Joe set: **both positive and negative feedback are welcome** — negatives tell
us where to improve, positives tell us what to do more of — and **no implementation tokens are spent
before we've agreed a change is worth doing** (issue-first, human-gated).

## Decisions (settled in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Workflow host | `ai-review improve` **CLI** + **Vercel cron** | Reuses existing CLI + cron infra; CLI for on-demand/local, cron for autonomous runs. |
| Corpus store | **Neon / Vercel Postgres** + **Drizzle ORM** | Serverless SQL; one `DATABASE_URL` reachable from cron, CLI, *and* dashboard — no host split. Real SQL for window/trend queries. (Dolt rejected: local-only, Vercel can't reach it.) |
| KV role | **Unchanged — raw daily buffer only** | The existing `src/feedback/*` pipeline keeps capturing reactions into KV; the corpus drains from it. No rewrite of working code. |
| Free-text scraping | **Batch LLM classifier** (cheap tier) in the cycle | Cron stays fast/cheap/LLM-free; classification + finding-match runs in the weekly cycle. |
| Repo scope | **No allowlist** | Both GitHub Apps are only installable on Joe's repos, so all installations = own repos. Nothing to gate. |
| Output / autonomy | **Issue-first, human-gated** | Trends surface in the dashboard; an Issue is a *brainstorm* → converges to a *spec* → only then a PR. Anomalies auto-file. The cycle **never opens PRs**. |
| Dashboard | **Next.js App Router, same Vercel project, GitHub OAuth (Joe-only)** | Joe's web-app default; one deploy, one `DATABASE_URL`. "See the data before we act." |
| Signal polarity | **Measure downvote *and* up-vote/usefulness ratios** | Surface what's working, not just what's broken. |
| QC | **Dedicated QC GitHub App**, **same-provider judge**, `/qc` command **or** random sample | Distinct QC identity on report comments; Anthropic findings judged by an Anthropic model, OpenAI by OpenAI. |
| Cadence | **Daily** capture (LLM-free) + **weekly** trend/QC cycle + **fast-path** anomaly issue | Spikes surface within a day; deep analysis weekly. |

## Non-goals

- Auto-merging any change to prompts/skills/code (issue-first + human spec approval is the whole point).
- Auto-opening PRs from the cycle (PRs come from normal dev once a spec is approved).
- Third-party repo coverage / multi-tenant privacy controls (apps are Joe-only).
- Replacing the existing KV feedback pipeline (it stays as the buffer).

## Architecture

```text
        DAILY (fast cron, no LLM)              WEEKLY + FAST-PATH (improve cron / CLI, LLM)
 GitHub PRs ─reactions─▶ Upstash KV ─drain─▶ Neon Postgres corpus (Drizzle)
 (own repos)─comments──▶  fb:* buffer         raw_feedback ▶ classified ▶ finding_catalog/match
     ▲                                         qc_scores ▶ trends ▶ proposals
     │                                                 │
     │  QC report comment / anomaly issue             ▼
     └────────────────────────  Dashboard (Next.js, GitHub OAuth) ── "open issue from metric" ──▶ GitHub Issue
                                  reads corpus, links issues/PRs        (brainstorm → spec → approve → PR)

 QC GitHub App (dedicated) ── /qc (issue_comment) OR weekly random sample ──▶ judge findings (same-provider) ──▶ QC report comment + qc_scores
```

KV (`src/feedback/*`) is the ephemeral daily buffer; Postgres is the durable, SQL-queryable corpus
feeding both the cycle and the dashboard. Every phase is gated by `IMPROVE_ENABLED` + a sub-flag
(mirrors `feedbackEnabled`/`tier2Enabled` in `src/config.ts`), so partial deploys are safe.

## Neon schema (Drizzle) — `src/improve/db/schema.ts`

Conventions: `pgEnum` for closed sets; `bigserial` PKs; `timestamptz` (default `now()`); `numeric` for
ratios/money; `text[]` for skills; all idempotent writes via `INSERT … ON CONFLICT (<unique>) DO NOTHING/UPDATE`.

```text
pgEnum provider        = ['anthropic','openai']
pgEnum feedback_source = ['inline_reaction','review_reaction','inline_reply','pr_comment']
pgEnum feedback_intent = ['downvote','upvote','bug_report','noise']
pgEnum trend_kind      = ['skill_downvote_ratio','skill_positive_signal','repeated_fp_signature','qc_disagreement','downvote_spike']
pgEnum qc_trigger      = ['command','sample']
pgEnum proposal_kind   = ['issue','pr']
pgEnum proposal_status = ['open','spec_ready','approved','pr_open','closed_merged','closed_rejected']
```

### `raw_feedback` — append-only landing (drained KV events + scraped comments/reactions)

| col | type | notes |
|---|---|---|
| id | bigserial PK | |
| source | feedback_source NOT NULL | |
| provider | provider NOT NULL | |
| owner, repo | text NOT NULL | |
| pr | integer NOT NULL | |
| comment_id | bigint NULL | inline/issue comment id (null where N/A) |
| review_id | bigint NULL | for `review_reaction` |
| in_reply_to_id | bigint NULL | GitHub `in_reply_to_id` thread linkage |
| path | text NULL | provenance key part |
| line | integer NULL | provenance key part |
| skills | text[] NULL | copied from KV/catalog at capture |
| title | text NULL | finding title at post time |
| verdict | text NULL | `'up'`/`'down'` for reactions; null for free-text |
| actor | text NOT NULL | reactor/commenter login |
| body | text NULL | free-text body (null for reactions) |
| event_at | timestamptz NOT NULL | reactedAt / comment createdAt |
| captured_at | timestamptz NOT NULL default now() | |
| dedup_key | text NOT NULL **UNIQUE** | reactions `react:{source}:{targetId}:{actor}:{verdict}`; free-text `cmt:{source}:{commentId}` |

Indexes: `(provider,owner,repo,pr)`, `(source)`, `(captured_at)`, unique `(dedup_key)`.

### `classified_feedback` — 1:1 with each free-text `raw_feedback` row (reactions skip the classifier)

| col | type | notes |
|---|---|---|
| id | bigserial PK | |
| raw_feedback_id | bigint NOT NULL **UNIQUE** FK→raw_feedback | one classification per row |
| intent | feedback_intent NOT NULL | |
| confidence | numeric(3,2) NOT NULL | |
| is_bot_related | boolean NOT NULL | false ⇒ treated as noise |
| matched_finding_id | bigint NULL FK→finding_catalog | result of `matchToFinding` |
| fp_signature | text NULL | normalized `skills+title` for repeated-FP collapse |
| model | text NOT NULL | classifier model id |
| classified_at | timestamptz NOT NULL default now() | |

Indexes: `(intent)`, `(matched_finding_id)`, `(fp_signature)`.

### `finding_catalog` — the bot's posted findings (join target)

| col | type | notes |
|---|---|---|
| id | bigserial PK | |
| provider | provider NOT NULL | |
| owner, repo | text NOT NULL | |
| pr | integer NOT NULL | |
| comment_id | bigint NULL | inline comment id (null for general findings) |
| review_id | bigint NULL | |
| path | text NULL | |
| line | integer NULL | |
| skills | text[] NOT NULL | skills that raised it |
| title | text NOT NULL | |
| severity | text NULL | from review metadata |
| head_sha | text NOT NULL | |
| posted_at | timestamptz NOT NULL | |
| natural_key | text NOT NULL **UNIQUE** | `{provider}:{owner}/{repo}#{pr}:{path}:{line}:{titleHash}` |

Indexes: unique `(natural_key)`, `(provider,owner,repo,pr)`, GIN `(skills)`.

### `qc_scores` — LLM-as-judge re-scores of posted findings

| col | type | notes |
|---|---|---|
| id | bigserial PK | |
| finding_id | bigint NOT NULL FK→finding_catalog | |
| provider | provider NOT NULL | model that judged = the finding's provider |
| trigger | qc_trigger NOT NULL | `command` (`/qc`) or `sample` |
| is_false_positive | boolean NOT NULL | |
| is_useful | boolean NOT NULL | |
| severity_correct | boolean NOT NULL | |
| suggested_severity | text NULL | one of `SEVERITY_LEVELS` |
| rationale | text NOT NULL | |
| pr_comment_id | bigint NULL | the QC report comment posted |
| model | text NOT NULL | |
| judged_at | timestamptz NOT NULL default now() | |
| dedup_key | text NOT NULL **UNIQUE** | `qc:{finding_id}:{judgeRunId}` |

### `qc_runs` — one row per PR QC pass (prevents double-commenting)

| col | type | notes |
|---|---|---|
| id | bigserial PK | |
| owner, repo | text NOT NULL | |
| pr | integer NOT NULL | |
| trigger | qc_trigger NOT NULL | |
| pr_comment_id | bigint NULL | the report comment |
| findings_judged | integer NOT NULL | |
| false_positives | integer NOT NULL | |
| ran_at | timestamptz NOT NULL default now() | |
| dedup_key | text NOT NULL **UNIQUE** | `qcrun:{owner}/{repo}#{pr}:{headSha}` — one report per PR head |

### `trends` — detected signals (both degrading and positive)

| col | type | notes |
|---|---|---|
| id | bigserial PK | |
| kind | trend_kind NOT NULL | |
| signature | text NOT NULL | skill name / fp_signature / `skill:metric` |
| window_start, window_end | timestamptz NOT NULL | |
| metric_value | numeric NOT NULL | ratio or count |
| sample_size | integer NOT NULL | denominator (suppress low-n) |
| detail | jsonb NOT NULL | supporting finding ids / example bodies |
| detected_at | timestamptz NOT NULL default now() | |
| dedup_key | text NOT NULL **UNIQUE** | `{kind}:{signature}:{weekBucket}` |

`skill_positive_signal` rows capture "what's working" (high up-vote/usefulness) — surfaced in the
dashboard, never auto-actioned.

### `proposals` — issues/PRs opened, for idempotency + dashboard linkage

| col | type | notes |
|---|---|---|
| id | bigserial PK | |
| trend_id | bigint NULL FK→trends | null for fast-path anomalies w/o a trend row |
| kind | proposal_kind NOT NULL | `issue` or `pr` |
| status | proposal_status NOT NULL default 'open' | advanced by reconcile |
| signature | text NOT NULL | same signature as the trend (dedup across cycles) |
| github_number | integer NULL | issue/PR number once opened |
| github_url | text NULL | |
| target_file | text NULL | suggested fix surface (`src/prompt.ts` / `skills/<x>.md`) |
| opened_at | timestamptz NOT NULL default now() | |
| dedup_key | text NOT NULL **UNIQUE** | `{kind}:{signature}` — one open proposal per signature |

**Idempotency / no-spam:** before opening, `SELECT … WHERE signature=$1 AND status IN ('open','spec_ready','approved','pr_open')`; if found, skip (optionally comment the new occurrence count). A **reconcile** step at the start of each cycle reads GitHub state for tracked numbers and advances `status` (`closed_merged`/`closed_rejected`) when Joe acts — re-arming detection for genuine recurrences.

## Module decomposition — `src/improve/*`

Conventions enforced: `"type":"module"` ESM with `.js` import extensions, **named exports only**, small
focused files, **no ASCII banner comments**, pure functions split from I/O (mirrors
`reactions.ts`'s `computeReactionDelta` pure vs `diffReactions` I/O split) so the bulk is unit-testable.

| File | Responsibility / key signatures |
|---|---|
| `db/client.ts` | `createDb()` — Drizzle singleton over a **pooled** Neon connection; drop-on-error (mirror `kvSingleton`). |
| `db/schema.ts` | Tables above. |
| `db/repo.ts` | Typed data access + SQL aggregations (`insertRawFeedback`, `upsertFinding`, `listUnclassified`, `aggregateSkillSignals`, `listFindingsForQc`, `upsertTrend`, `findOpenProposal`, …). |
| `drain.ts` | `mapKvEventToRaw(event)` (pure) + `drainKvEvents(deps)` — KV `fb:events` → `raw_feedback`. |
| `capture-comments.ts` | `scrapeReviewReactions(deps)` (carrier issue-comment reactions) + `scrapeReviewComments(deps)` (inline replies + PR comments) → `raw_feedback`. |
| `classify.ts` | `ClassifySchema` + `mapClassifierOutput(raw,out)` (pure) + `classifyComments(rows,sel)` (LLM batch). |
| `match.ts` | `matchToFinding(c, catalog)` (pure): thread-linkage → `path:line` → classifier hint. |
| `trends.ts` | `computeSkillDownvoteRatios` / `computeSkillPositiveSignal` / `detectRepeatedFp` / `detectQcDisagreement` (pure) over rows from `repo.ts`. |
| `anomaly.ts` | `detectAnomalies(rows, cfg)` (pure threshold checks → `AnomalySignal[]`). |
| `qc.ts` | `selectQcSample(findings, rate, rng)` (pure, seedable) + `judgeFinding(f, sel)` (model by `f.provider`) + `runPrQc(deps)` + `postQcComment(deps)` (QC-app Octokit). |
| `issues.ts` | `planIssue(signal)` (pure: evidence + suggested fix surface, incl. **new** guardrail blocks) + `openTrendIssue(deps)` (Octokit) + `reconcileProposals(deps)`. |
| `run.ts` | `runDailyCapture` / `runFastPath` / `runImproveCycle` orchestrators. |
| `cron.ts` | `improveRequest(opts)` — flag → `CRON_SECRET` auth → run (mirrors `feedback/cron.ts`). |
| `types.ts` | Shared interfaces (`RawFeedbackInput`, `ClassifiedComment`, `TrendSignal`, `AnomalySignal`, `QcScore`, `ProposalPlan`). |

**No `scope.ts`** (allowlist dropped). **No auto-PR module** — `issues.ts` proposes the fix *direction*
as a discussion-opener; PRs come from normal dev once a spec is approved, linked back via reconcile.

**Reuse, don't reinvent:**
- `src/feedback/reactions.ts` `computeReactionDelta`/`diffReactions` — verbatim for both reaction surfaces; only the fetch route differs.
- `src/feedback/store.ts` + `kv.ts` — the daily buffer (unchanged); `KvClient` is the drain source.
- `src/triage.ts` `triageSelection` + the `generateObject` pattern — cheap-tier classifier/QC/issue-drafting calls.
- `src/review.ts` `SEVERITY_LEVELS`, diff-fetch helpers, and the `commentProvenance` map (`path:line → {skills,title}`) — the bridge into `finding_catalog`.
- `src/github-app.ts` `maybeSubmitReview` (extend the feedback block ~line 480) + the `getInstallationOctokit` pattern from `api/cron/poll-feedback.ts`.
- `src/config.ts` parse helpers; `src/cli.ts` `requireValue`/`buildResolvePr`/`installationOctokit`.

## Dashboard — Next.js App Router (same Vercel project)

- **Views:** incoming feedback stream; per-skill **downvote ratios** (degrading) *and* **up-vote/usefulness ratios** (what's working); repeated-FP signatures; QC scores; anomalies. Each metric shows supporting examples (finding/comment links) and any linked GitHub issue/PR (from `proposals`).
- **Open issue from metric:** a server action calls `issues.ts` `openTrendIssue` with the selected trend's evidence → creates the GitHub Issue (brainstorm framing) → records/links the `proposals` row → the issue appears linked in the dashboard.
- **Auth:** GitHub OAuth via Auth.js (NextAuth) GitHub provider, allowlisted to `DASHBOARD_ALLOWED_LOGIN`. Dashboard routes protected; **webhook/cron routes stay public** (GitHub webhooks + QStash + `CRON_SECRET`-gated cron).
- **Data:** read-only Drizzle queries against the same Neon `DATABASE_URL`.

**Coexistence (must verify first — see Risks):** the repo's `api/*.ts` are Vercel Functions doing
raw-body HMAC with byte-exact URLs. Before converting, verify whether root-level `api/*` functions
coexist with a Next.js app on Vercel. Prefer adding Next.js for the dashboard only and leaving the
webhook/cron functions untouched; fallback is migrating them to `app/api/.../route.ts` preserving exact
paths + raw body (`req.text()`) + per-route `maxDuration`. Do not break the QStash URL match.

## Key mechanics

- **Top-level review reactions (footgun):** PR *reviews* are **not reactable**, and carrier reactions are
  read at `GET /repos/{o}/{r}/issues/comments/{id}/reactions` (NOT `pulls/comments`). In
  `maybeSubmitReview` (gated by `feedbackEnabled`) additionally post **one issue comment** carrying the
  review summary + the existing `feedbackInvite`; store its `comment_id`/`review_id`; the daily poll reads
  its reactions via the issues route, reusing `computeReactionDelta`. Tag `source=review_reaction`.
- **Free-text capture (daily, no LLM):** for PRs the bots reviewed, fetch inline thread replies
  (`GET /pulls/{n}/comments`, via `in_reply_to_id`) + PR comments (`GET /issues/{n}/comments`); land
  non-bot comments as `raw_feedback`. Classification is deferred to the cycle.
- **Classifier:** batch (~20/call), structured output `{id, intent, is_bot_related, confidence,
  matched_finding_hint}`, few-shot for "false positive → downvote / thanks → upvote / reviewer bug →
  bug_report / unrelated → noise". Matching is **deterministic first**: `in_reply_to_id →
  finding_catalog.comment_id`; fallback `path:line`; last resort the classifier's hint.
- **Trends (weekly):** per-skill downvote ratio (default ≥0.35, min sample 8); per-skill positive signal
  (up-vote/usefulness ratio ≥ `IMPROVE_SKILL_POSITIVE_RATIO`); repeated-identical-FP signature across ≥3
  PRs; QC-disagreement FP rate ≥0.25 (min sample 5). **Fast-path (daily, SQL-only):** downvote spike (≥5
  in 48h for one skill/signature) or repeated-complaint crossing → **auto-file an anomaly Issue** + reconcile dedup.
- **Issue-first proposal flow:** dashboard/anomaly → `openTrendIssue` files a GitHub Issue with evidence +
  a *suggested* fix surface (edit a `skills/*.md`, or add/edit a guardrail rule in `src/prompt.ts`) framed
  as a brainstorm. Discussion converges to a spec; on approval, normal dev produces the PR;
  `proposals.status` advances via reconcile. The cycle **never opens PRs**.
- **QC (dedicated app, two triggers):** (a) **`/qc` command** — a trusted author/agent comments `/qc` →
  `webhook-qc.ts` → `runPrQc` immediately; (b) **random sample** — `selectQcSample` (random
  `IMPROVE_QC_SAMPLE_RATE`, default 0.1) in the weekly cron. Both run `judgeFinding` (model = the finding's
  provider; **no agent re-run**) over posted findings vs the diff hunk → `qc_scores` → `postQcComment`
  posts a short report comment under the **QC bot identity** (findings judged, FPs found, usefulness,
  dashboard link), marked once-per-PR via `qc_runs`. High judge-FP rates feed the QC-disagreement trend.

## CLI + cron + config wiring

- **CLI:** `ai-review improve [--since 7d] [--qc-only] [--dry-run] [--no-capture] [--json]` — new
  `cmdImprove` in `src/cli.ts`; builds the Drizzle client + dual-app Octokit; calls `runImproveCycle`.
  `--dry-run` computes/prints, files nothing.
- **Cron:** extend `api/cron/poll-feedback.ts` (daily) to also run `runDailyCapture` + `runFastPath`
  (flag-gated, LLM-free, under `maxDuration:60`); add `api/cron/improve.ts` (weekly, `maxDuration:300`).
  `vercel.json` crons: keep `0 0 * * *` poll-feedback; add `0 6 * * 1` improve.
- **QC app webhook:** new `api/github/webhook-qc.ts` (subscribes `issue_comment.created`, HMAC via
  `QC_APP_WEBHOOK_SECRET`); parses `/qc` via a new `parseQcCommand` in `src/commands.ts` (trusted-author
  gated, reuse `isTrustedAuthorAssociation`); runs `runPrQc` inline (`maxDuration:300`). Register the
  dedicated QC GitHub App (webhook URL on the prod domain `claude-review-bot.vercel.app`) + install on Joe's repos.
- **Config (`src/config.ts`):** `DATABASE_URL`; QC app creds (`QC_APP_ID`, `QC_APP_PRIVATE_KEY`,
  `QC_APP_WEBHOOK_SECRET`) via `getQcAppConfig()`/`getQcGitHubApp()`; `QC_COMMAND` (default `/qc`);
  `IMPROVE_ENABLED` + `IMPROVE_CAPTURE_ENABLED`/`IMPROVE_PROPOSALS_ENABLED`/`IMPROVE_QC_ENABLED`;
  thresholds (`IMPROVE_SKILL_DOWNVOTE_RATIO`, `_SKILL_POSITIVE_RATIO`, `_MIN_SAMPLE`,
  `_REPEATED_FP_THRESHOLD`, `_QC_FP_RATE`, `_SPIKE_WINDOW_HOURS`, `_SPIKE_DOWNVOTES`, `_QC_SAMPLE_RATE`)
  parsed with a `parseNumberEnv` helper mirroring `parseDelayMs`; model overrides
  (`IMPROVE_CLASSIFIER_MODEL`/`_QC_MODEL`/`_ISSUE_MODEL`); `IMPROVE_TARGET_REPO` (default
  `joeblackwaslike/ai-review-bot`); dashboard auth (`GITHUB_OAUTH_CLIENT_ID`/`_SECRET`, `AUTH_SECRET`,
  `DASHBOARD_ALLOWED_LOGIN`). Add `.env.example` entries.

## Runbook deliverables — `agent-skills/skills/working-with-github/references/howto/`

No manifest — register via the `## Quick reference` table in `working-with-github/SKILL.md`. Match the
numbered prose+bash+TS style of `driving-a-pr-to-approval.md`. (Separate repo — own worktree/commit.)

- **Add `giving-feedback-on-ai-reviews.md`:** why feedback matters (both 👍 and 👎); react 👍/👎 on an
  inline comment (`pulls/comments/{id}/reactions`); react on the top-level review via its **summary issue
  comment** (`issues/comments/{id}/reactions`, with the "reviews aren't reactable" note); reply with
  criticism vs praise (phrasings read as downvote/upvote); report a suspected reviewer bug; **flag a PR
  for QC with `/qc`**; where feedback goes (KV → Postgres → dashboard → weekly trends → issues; QC
  comments) and the cadence.
- **Add `tuning-the-ai-reviewer.md`** (maintainer-facing): read the dashboard (degrading *and* working) +
  auto-filed anomaly issues; turn a trend issue's brainstorm into a spec; fix surfaces (`skills/*.md`,
  guardrail rules in `src/prompt.ts`); threshold→env-var map; the `/qc` flow.
- **Edit `driving-a-pr-to-approval.md`:** add a short "Give the AI reviewer feedback" subsection in the
  review-loop steps (react 👍/👎, reply with reasons, `/qc` to flag a suspect review) linking over to
  `giving-feedback-on-ai-reviews.md`.
- **Edit `SKILL.md`** Quick reference: add rows for both new runbooks.

## Build sequence (phases, each shippable behind a flag)

1. **Corpus foundation** — Neon project + `DATABASE_URL`, Drizzle schema + migration, `db/client.ts`
   (pooled singleton), `db/repo.ts`.
2. **Capture extension** — carrier issue comment + `finding_catalog` upsert in `maybeSubmitReview`;
   `drain.ts`; `capture-comments.ts`; wire into daily `poll-feedback` cron.
3. **Classify + match** — `classify.ts` + `match.ts`.
4. **Trends + anomalies** — `trends.ts` (downvote + positive) + `anomaly.ts` + SQL; fast-path auto-issue.
5. **QC app + sampling** — register the QC GitHub App; `api/github/webhook-qc.ts` + `parseQcCommand`;
   `qc.ts` (`runPrQc`, same-provider `judgeFinding`, `postQcComment`); random sample in cron; QC-disagreement trend.
6. **Issues + reconcile** — `issues.ts` (`planIssue`/`openTrendIssue`/`reconcileProposals`).
7. **CLI + weekly cron** — `cmdImprove`, `api/cron/improve.ts`, `vercel.json`, config flags, `.env.example`.
8. **Dashboard** — Next.js App Router + GitHub OAuth (verify Vercel coexistence FIRST); corpus views;
   "open issue from metric" server action.
9. **Runbooks** — two new howtos + edit `driving-a-pr-to-approval.md` + SKILL.md table.

## Risks / footguns

- **Next.js + existing functions (verify first, no assumption):** `api/*.ts` do raw-body HMAC (GitHub
  webhook + QStash) with byte-exact URLs (`PUBLIC_URL` is signed into the QStash JWT). Verify Vercel/Next
  coexistence before converting; prefer adding Next.js for the dashboard only; fallback migrates functions
  to `app/api/.../route.ts` preserving paths + raw body + `maxDuration`. Never break the QStash URL match.
- **PR-review reactions:** reviews aren't reactable; use the carrier issue comment + `issues/comments/.../reactions`.
- **Dedicated QC app:** new registration, webhook URL on the prod domain, private key + secret, install on
  Joe's repos, separate signature path; needs both `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` (same-provider
  judging). Keep the handler minimal (`/qc` only); `isTrustedAuthorAssociation`-gate so randoms can't trigger spend.
- **Neon in serverless:** use the pooled connection + module-level singleton (drop-on-error) or
  cron+webhook+dashboard concurrency exhausts connections.
- **Self-modifying loop:** proposals touch the very prompts/skills driving the reviewer — issue-first +
  human spec approval + signature dedup + reconcile prevent a merged guardrail re-triggering its own trend.
- **Daily budget / classifier cost:** daily stays LLM-free; LLM work is weekly; classify only
  un-classified, batched rows.
- **KV→PG drain races:** idempotent via `dedup_key`; don't destructively pop KV before durable write.
- **OAuth:** lock the dashboard to `DASHBOARD_ALLOWED_LOGIN`; never expose corpus or issue creation to unauthenticated requests.

## Testing strategy

Gates that must stay green: `npm run typecheck`, `npm run lint` (Biome), `npm run test` (Vitest, currently 277).

- **Unit (bulk, pure functions):** `classify` output mapping (incl. `is_bot_related=false → noise`);
  `match` (thread hit / `path:line` / hint / none); `trends` ratio + positive-signal math + min-sample
  suppression; `detectRepeatedFp` + `detectAnomalies` threshold boundaries; `selectQcSample` determinism
  with a seeded RNG (rate 0 and 1 edges); `judgeFinding` model-by-provider selection; `planIssue`
  fix-surface selection incl. new-block proposal; `mapKvEventToRaw` + dedup-key derivation; `parseQcCommand`
  + trusted-author gate. Fixtures added to `src/testing.ts` (`buildFeedbackEvent`, `buildFindingRow`,
  `buildClassifiedComment`, `buildQcScore`, `buildRawReaction`) — plain data builders, no vitest import.
- **DB layer:** `db/repo.ts` against **pg-mem** in CI; opt-in integration test against a Neon test branch
  (`DATABASE_URL_TEST`, skipped when unset). Keep SQL thin; push computation into tested pure functions.
- **Idempotency:** double-insert raw event/proposal → one row (ON CONFLICT); mocked Octokit (like
  `reactions.test.ts`/`persist.test.ts`) asserts the dedup `SELECT` short-circuits a second issue; QC
  comment posts once per PR (`qc_runs`).
- **Dashboard:** local `next dev` against a seeded Neon branch; GitHub OAuth login (allowlisted); verify
  trend views + "open issue from metric" creates a linked issue; confirm webhook/cron routes stay public.
- **End-to-end (dry-run first):** seed `raw_feedback` → `ai-review improve --dry-run --json` prints
  trends/QC without filing → drop `--dry-run` to auto-file an anomaly issue + post a QC comment → react
  👍/👎 on a live test PR's inline + carrier comment, run the daily cron locally, confirm rows land in Neon
  and show in the dashboard.

## Open questions (resolve during implementation)

1. **Vercel Next.js ↔ root `api/*` coexistence** — the single highest-risk unknown; verify against docs
   before Phase 8 (determines "add dashboard only" vs "migrate functions").
2. **Neon driver** — `@neondatabase/serverless` (HTTP/WS, best for serverless) vs `postgres` + a pooler;
   pick during Phase 1 against the pooling constraint.
3. **QC `/qc` execution budget** — inline vs QStash-delegated for very large PRs (start inline at
   `maxDuration:300`, revisit if findings counts blow the budget).
4. **pg-mem fidelity** — confirm it models the `unnest(skills)` aggregations; if not, gate those queries
   behind the opt-in Neon integration test.
