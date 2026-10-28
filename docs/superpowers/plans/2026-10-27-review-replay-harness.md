# Review Replay Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record real PR review history into fixtures, label what happened to each finding, replay the rounds through a pluggable pipeline, and report author rejection rate, recycling, and convergence.

**Architecture:** A platform-neutral core in `src/replay/` (types, labeler, replay engine, metrics, guard) with no GitHub types. Only the recorder talks to GitHub, through an injected `GhClient`, so every test runs offline. A thin `ai-review replay` subcommand drives it, and a small opt-in live tier re-runs the real reviewer.

**Tech Stack:** TypeScript ESM, Vitest, Biome, Octokit-free `gh` CLI for the default client.

**Spec:** [docs/superpowers/specs/2026-10-27-review-replay-harness-design.md](../specs/2026-10-27-review-replay-harness-design.md). Epic: [docs/superpowers/specs/2026-10-27-review-accuracy-epic-design.md](../specs/2026-10-27-review-accuracy-epic-design.md). The "Hardening decisions" section of the spec wins where it conflicts with earlier sections.

## Global Constraints

- TypeScript ESM; imports use `.js` suffixes; named exports only; tests colocated as `src/replay/*.test.ts`; Biome formatting. `npm run typecheck`, `npm run lint`, and `npm test` must pass before every commit.
- `src/replay/types.ts`, the labeler, engine, metrics, and guard import no GitHub or Octokit types. Only `record.ts` and `gh.ts` know GitHub.
- The offline replay is deterministic, makes no network calls, and runs inside `npm test`. The live tier is never part of `npm test`.
- The live tier uses local subscription auth as `ai-review review` does and is never imported from webhook paths.
- Fixtures hold review text, replies, reactions, commit SHAs, and changed-file line ranges. They never hold diff bodies.
- Evidence is visible to a round only if its timestamp is before the round's cutoff: the time the reviewed head was pushed, else the review's `submittedAt` minus 15 minutes. Unknown timestamps are not visible.
- Every reported rate prints counts ("4 of 10"). CI asserts on the recall guard and on snapshot stability, never on rate thresholds.
- False-positive rate is the author rejection rate: rejected over fixed plus rejected. Deferred and unadjudicated are shown separately and excluded from the rate.
- Link and path references in docs use repo-relative markdown links; bead IDs are plain text.

## Review Focus

- A force-pushed PR where a round's reviewed head no longer exists: the round is marked `approximate`, not dropped (Task 2).
- One inline comment holding three claims joined by `\n\n---\n\n`: three claims, each labelable on its own (Task 1, Task 3).
- A reply edited after the cutoff: the original timestamp governs and the edit is flagged (Task 2, Task 4).
- A reply or reaction from a third-party bot or from a non-author user: ignored as evidence (Task 2, Task 3).
- A pipeline that suppresses everything except confirmed fixed claims: the guard reports every other suppression as unexpected (Task 5).

---

### Task 1: Core types, claim splitting, and body-finding parsing

**Files:**
- Create: `src/replay/types.ts`, `src/replay/claims.ts`, `src/replay/claims.test.ts`
- Modify: `src/review-state.ts` (extract and export `parseBodyFindings` from `parsePriorReview`), `src/review-state.test.ts`

**Interfaces:**
- Produces in `types.ts` (all exported):
  - `type Provider = "anthropic" | "openai"`; `type Label = "fixed" | "rejected" | "deferred" | "unadjudicated"`
  - `interface PostedClaim { id: string; roundIndex: number; reviewId: number; source: "inline" | "body"; commentId: number | null; path: string | null; line: number | null; severity: string; title: string; text: string }`
  - `interface CommitMeta { sha: string; committedAt: string; files: { path: string; ranges: [number, number][] }[] }`
  - `interface Round { index: number; reviewId: number; provider: Provider; submittedAt: string; headSha: string; baseSha: string; mergeBase: string | null; triggerAt: string | null; approximate: boolean; commitsSince: CommitMeta[]; claims: PostedClaim[] }`
  - `interface Reply { id: number; author: string; createdAt: string; editedAt: string | null; body: string }`
  - `interface ThreadEvidence { threadId: string; commentId: number; isResolved: boolean; isOutdated: boolean; resolvedBy: string | null; replies: Reply[] }`
  - `interface ReactionEvidence { commentId: number; user: string; content: string; createdAt: string }`
  - `interface ReplayFixture { schemaVersion: 1; owner: string; repo: string; pull: number; provider: Provider; author: string; recordedAt: string; rounds: Round[]; threads: ThreadEvidence[]; reactions: ReactionEvidence[] }`
  - `interface ClaimLabel { claimId: string; label: Label; confidence: "high" | "low"; evidence: string[]; confirmed: boolean }` where each `evidence` entry is formatted `<ISO timestamp>|<text>`, or `unknown|<text>` when the source has no timestamp
  - `interface RepeatPair { later: string; earlier: string; confirmed: boolean }`; `interface NegativePair { a: string; b: string }`
  - `interface LabelFile { fixtureId: string; provisional: boolean; labels: ClaimLabel[]; repeatPairs: RepeatPair[]; negativePairs: NegativePair[]; allowedSuppression: string[] }`
- Produces in `claims.ts`: `splitInlineClaims(body: string): { title: string; text: string }[]` and `fixtureId(f: Pick<ReplayFixture, "owner" | "repo" | "pull" | "provider">): string` (`owner__repo__pull__provider`).
- Produces in `review-state.ts`: `parseBodyFindings(body: string): PersistedFinding[]`, the row-parsing loop currently inside `parsePriorReview`, with `parsePriorReview` calling it.

- [ ] **Step 1: Write failing tests** in `claims.test.ts`: `splits a comment joined by the merge separator into three claims` (input three bodies joined with `"\n\n---\n\n"`, expect length 3 and the first claim's title equal to its bold heading text); `returns one claim for a body with no separator`; `fixtureId joins with double underscores`. In `review-state.test.ts` add `parseBodyFindings returns the same rows parsePriorReview used` over an existing fixture body.
- [ ] **Step 2: Run** `npx vitest run src/replay/claims.test.ts src/review-state.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement** `types.ts` as listed (including the evidence format), `splitInlineClaims` by splitting on `\n\n---\n\n` and taking each part's first bold span, else first line, as `title`, and extract `parseBodyFindings` without changing behavior.
- [ ] **Step 4: Run** the same command plus `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): core types, claim splitting, body-finding parser`.

### Task 2: GhClient and the recorder

**Files:**
- Create: `src/replay/gh.ts`, `src/replay/record.ts`, `src/replay/record.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `splitInlineClaims`, `parseBodyFindings`.
- Produces in `gh.ts`: `interface GhClient { rest<T>(route: string, params?: Record<string, string | number>): Promise<T>; graphql<T>(query: string, vars?: Record<string, string | number>): Promise<T> }` and `ghCli(): GhClient` (shells out to `gh api`, paginating REST lists).
- Produces in `record.ts`: `recordPr(client: GhClient, opts: { owner: string; repo: string; pull: number; provider: Provider; botLogin: string; now?: () => Date }): Promise<ReplayFixture>`.

- [ ] **Step 1: Write failing tests** with a fake `GhClient` returning canned responses: `builds one round per bot review in submit order` (bot login `anthropicreviewbot`, two reviews, expect `rounds.map(r => r.index)` is `[0, 1]` and each `headSha` read from the `<!-- ai-review:sha=... -->` marker); `splits a three-claim inline comment into three claims with one commentId`; `ignores reviews and replies from other bots`; `keeps only reactions from the PR author, with actor and createdAt`; `stores thread isOutdated, isResolved and resolvedBy`; `marks a round approximate when its head SHA is missing from the compare response`; `records changed files and hunk line ranges per commit between rounds but no patch text`; `stores editedAt for an edited reply and keeps the original createdAt`.
- [ ] **Step 2: Run** `npx vitest run src/replay/record.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `recordPr`. Reviews via `GET /repos/{owner}/{repo}/pulls/{pull}/reviews`, inline comments via `.../pulls/{pull}/comments`, threads via the GraphQL `reviewThreads` query (see `src/resolve-threads.ts` for the shape), reactions via `GET /repos/{owner}/{repo}/pulls/comments/{id}/reactions`, commits and hunk ranges via `GET /repos/{owner}/{repo}/compare/{base}...{head}` (parse the `@@ -a,b +c,d @@` headers of `patch` into ranges, then discard the patch). `triggerAt` is the head commit's committer date when the compare call finds it, else `null`. Body-table claims come from `parseBodyFindings` with `source: "body"`.
- [ ] **Step 4: Run** the test file and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): GhClient and PR recorder`.

### Task 3: Labeler

**Files:**
- Create: `src/replay/label.ts`, `src/replay/label.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `labelFixture(f: ReplayFixture): LabelFile` (all labels `confirmed: false`, `provisional: true`) and `mergeConfirmations(proposed: LabelFile, edited: LabelFile): LabelFile` (an edited label or pair with `confirmed: true` replaces the proposal; `provisional` becomes false only when every label in `allowedSuppression` and every fixed label is confirmed).

- [ ] **Step 1: Write failing tests**: `labels "Intentional" and "No change" replies as rejected, quoting the reply` ; `labels "By design" and "Agreed there's no defect" as rejected`; `labels an outdated thread plus a "Fixed in <sha>" reply as fixed with high confidence`; `labels a changed hunk with no reply or outdated flag as fixed with low confidence`; `labels "follow-up" and "out of scope" replies as deferred, not rejected`; `treats a 😕 or 👎 from the PR author as a rejection signal and one from another user as none`; `ignores replies by non-author accounts`; `labels a claim with no evidence unadjudicated`; `proposes a repeat pair for same-path, nearby-line, shared-identifier claims in later rounds, including claims moved to another file when titles match`; `every non-unadjudicated label carries at least one evidence entry formatted <ISO timestamp>|<text> or unknown|<text>`.
- [ ] **Step 2: Run** `npx vitest run src/replay/label.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the rules as ordered checks (reply phrase lists first, then outdated plus fix reference, then hunk overlap, then reactions). Pair proposals reuse `isSameClaim` from `src/claim-dedupe.ts` plus a title-equality check for cross-file moves; proposals only, never final.
- [ ] **Step 4: Run** the test file and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): heuristic labeler with confirmation merge`.

### Task 4: Pipeline interface and replay engine

**Files:**
- Create: `src/replay/pipeline.ts`, `src/replay/replay.ts`, `src/replay/replay.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 3 `LabelFile`.
- Produces in `pipeline.ts`: `interface LedgerView { priorClaims: PostedClaim[]; labels: Map<string, ClaimLabel> }`; `type ReplayPipeline = (input: { round: Round; claims: PostedClaim[]; ledger: LedgerView }) => { posted: string[]; suppressed: string[] }` (claim IDs); `asRecordedPipeline: ReplayPipeline` (posts everything); `todaysCodePipeline: ReplayPipeline` (a thin wrapper that suppresses nothing, documented as the interface check until sprint 2).
- Produces in `replay.ts`: `roundCutoff(round: Round): Date`; `visibleLabels(f: ReplayFixture, labels: LabelFile, cutoff: Date): Map<string, ClaimLabel>`; `replayFixture(f: ReplayFixture, labels: LabelFile, pipeline: ReplayPipeline): ReplayResult` with `ReplayResult = { fixtureId: string; rounds: { index: number; posted: string[]; suppressed: string[] }[] }`.

- [ ] **Step 1: Write failing tests**: `cutoff is triggerAt when known`; `cutoff is submittedAt minus 15 minutes when triggerAt is null`; `a label whose evidence is timestamped after the cutoff is not visible`; `a label with unknown evidence timestamp is not visible`; `an edited reply is visible by its original createdAt`; `the ledger passed to round N holds only claims from rounds before N`; `asRecordedPipeline posts every claim and suppresses none`; `a custom pipeline's suppressed ids are recorded per round`.
- [ ] **Step 2: Run** `npx vitest run src/replay/replay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** visibility is a filter on the timestamp prefix of each `ClaimLabel.evidence` entry (`unknown` is never visible).
- [ ] **Step 4: Run** the test file and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): pipeline interface and replay engine`.

### Task 5: Metrics and recall guard

**Files:**
- Create: `src/replay/metrics.ts`, `src/replay/guard.ts`, `src/replay/metrics.test.ts`, `src/replay/guard.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4.
- Produces in `metrics.ts`: `computeMetrics(f: ReplayFixture, labels: LabelFile, result: ReplayResult): Metrics` where `Metrics = { rejection: { rejected: number; adjudicated: number }; deferred: number; unadjudicated: number; recycled: { count: number; posted: number }; restatedOpen: { count: number; posted: number }; convergence: { roundsWithFirstSeen: number; totalRounds: number; finalRoundQuiet: boolean } }` and `formatReport(m: Metrics[], ids: string[]): string` (counts like `4 of 10`, never a bare percentage).
- Produces in `guard.ts`: `checkRecall(f: ReplayFixture, labels: LabelFile, result: ReplayResult): GuardReport` with `GuardReport = { failures: string[]; warnings: string[]; unexpectedSuppression: string[] }`.

- [ ] **Step 1: Write failing tests** for metrics: `rejection rate counts rejected over fixed plus rejected and excludes deferred and unadjudicated`; `recycled counts a posted claim that has a confirmed pair to an earlier settled claim`; `restated open counts a pair to an earlier claim that is still open`; `neither repeat kind counts toward convergence`; `roundsWithFirstSeen counts rounds posting at least one claim with no earlier pair`; `formatReport prints "4 of 10" style counts`. Guard: `suppressing a confirmed fixed claim in its first round fails`; `suppressing a claim in allowedSuppression passes`; `suppressing any other claim is reported as unexpected and fails when its label is confirmed`; `the same failure on a provisional label is only a warning`; `two similar claims in negativePairs both survive or the guard fails`; `suppressing everything except confirmed fixed claims reports every other suppression as unexpected`.
- [ ] **Step 2: Run** `npx vitest run src/replay/metrics.test.ts src/replay/guard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules over the Task 1 label data; a claim is "settled" at round N if its visible label (cutoff of round N) is fixed, rejected, or deferred.
- [ ] **Step 4: Run** both test files and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): metrics and recall guard`.

### Task 6: `ai-review replay` subcommand and snapshot test

**Files:**
- Create: `src/replay/command.ts`, `src/replay/command.test.ts`, `src/replay/snapshot.test.ts`
- Modify: `src/cli.ts` (add `if (sub === "replay") return cmdReplay(rest)`), the CLI usage text in `src/cli.ts`

**Interfaces:**
- Consumes: Tasks 2 to 5.
- Produces in `command.ts`: `runReplay(args: string[], deps?: { client?: GhClient; fixturesDir?: string; out?: (s: string) => void }): Promise<number>` returning an exit code. Flags: none (replay all fixtures in `src/replay/fixtures/`, print report, exit 1 on any guard failure), `--record <pr-url> --provider anthropic|openai --bot <login>` (writes `<fixtureId>.json` and a proposed `<fixtureId>.labels.json`; never overwrites an existing labels file that has confirmed entries, writing `.labels.proposed.json` instead), `--live` is added in Task 8.

- [ ] **Step 1: Write failing tests**: `no flags replays every fixture in the directory and prints counts`; `exits 1 when the guard has a failure and 0 when only warnings`; `--record writes the fixture and a proposed labels file with the fake client`; `--record does not overwrite a labels file that has confirmed entries`; `unknown flag prints usage and exits 2`. Snapshot test `snapshot.test.ts`: loads the committed fixtures (added in Task 7), asserts they parse, that `checkRecall` has no failures, and that `formatReport` matches a committed snapshot (`toMatchSnapshot`).
- [ ] **Step 2: Run** `npx vitest run src/replay/command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `runReplay` and the one-line dispatch in `src/cli.ts`. The snapshot test skips cleanly with a clear message while no fixtures exist.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): ai-review replay subcommand`.

### Task 7: Record the three incident PRs

**Files:**
- Create: `src/replay/fixtures/*.json` and `src/replay/fixtures/*.labels.json` for stealth-browser#1, ai-listings#74, agent-skills#10, both providers where a bot reviewed.
- Modify: `src/replay/snapshot.test.ts` snapshot file (generated).

**Interfaces:**
- Consumes: Task 6 `runReplay --record`. Bot logins `anthropicreviewbot` (provider `anthropic`) and `codexreviewbot` (provider `openai`).

- [ ] **Step 1: Record** each PR and provider: `npm run build >/dev/null; node dist/cli.js replay --record https://github.com/joeblackwaslike/stealth-browser/pull/1 --provider anthropic --bot anthropicreviewbot`, then the same for the other five combinations (Codex for the three PRs, Claude for the other two PRs).
- [ ] **Step 2: Verify the incident numbers are reproduced**: `node dist/cli.js replay` shows, for stealth-browser#1 Claude, four rounds and the `throttle.ts` inFlight claim present in all four, and for ai-listings#74 Claude the rollout-restart claim in rounds 3 and 4. If a number is off, fix the recorder or labeler, not the expected values.
- [ ] **Step 3: Hand-confirm the spot-check set**: for each fixture, edit the `.labels.json` so every fixed label, every repeat pair, and `allowedSuppression` has `confirmed: true`, then set `provisional: false`. Joe does the spot-check, so mark the committed labels `provisional: true` and list the open confirmations in the PR description.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test` and update the snapshot with `npx vitest run -u src/replay/snapshot.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `test(replay): record incident PR fixtures with provisional labels`.

### Task 8: Live tier

**Files:**
- Create: `src/replay/live.ts`, `src/replay/live.test.ts`
- Modify: `src/replay/command.ts` (add `--live --rounds <n> --max-cost <usd>`)

**Interfaces:**
- Consumes: Task 2 `GhClient`, existing `runLocalReview` in `src/audit.ts`, Task 3 labels.
- Produces: `runLiveTier(opts: { fixture: ReplayFixture; labels: LabelFile; rounds: number[]; maxCostUsd: number; review: (diffInput: string) => Promise<{ title: string; path: string | null; line: number | null }[]> ; estimateCost: (diffInput: string) => number; fetchDiff: (round: Round) => Promise<{ diff: string; approximate: boolean }> }): Promise<LiveReport>` with `LiveReport = { spentUsd: number; rounds: { index: number; matchedFixed: number; matchedRejected: number; newUnlabeled: number; approximate: boolean }[] }`.

- [ ] **Step 1: Write failing tests** with injected fakes: `stops before a round whose estimated cost would exceed maxCostUsd`; `prints the total estimated spend before the first review call`; `matches live findings only through confirmed pairs and reports the rest as newUnlabeled`; `reports no accuracy figure for newUnlabeled findings`; `marks a round approximate when fetchDiff says the history was rewritten`.
- [ ] **Step 2: Run** `npx vitest run src/replay/live.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `runLiveTier` and the CLI flags. The real `review` and `fetchDiff` are wired only in `command.ts` (`fetchDiff` uses the recorded base and merge-base with `gh api compare`); nothing in `npm test` reaches them.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(replay): capped live tier`.

---

## Self-review notes

- Spec coverage: types and claims (Task 1), recorder with thread state, reactions, hunk ranges, cutoff data (Task 2), labels with evidence and pairs (Task 3), visibility cutoff and plug-in pipeline (Task 4), the three measures, restated open count, recall guard with allowed-suppression, negative pairs, provisional warnings (Task 5), CLI and snapshot (Task 6), incident fixtures and spot-check handoff (Task 7), live tier (Task 8). "What this harness does not verify" is documentation only.
- Type names match across tasks: `PostedClaim`, `Round`, `ReplayFixture`, `LabelFile`, `ReplayPipeline`, `ReplayResult`, `Metrics`, `GuardReport`.
