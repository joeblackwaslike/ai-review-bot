# Ledger and Repeat Suppression Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Goal: A claim the author or a collaborator has settled is never posted again, and a re-review round with nothing new posts nothing.

Architecture: A platform-neutral `Ledger` (`src/ledger/`) is rebuilt from GitHub review threads on every run. A pure matcher and suppressor drop settled repeats from each agent's review before the merge, and the same code is the default pipeline of the sprint 1 replay harness, which measures it.

Tech Stack: TypeScript ESM, vitest, biome, zod, Octokit (`context.octokit.request`).

Spec: [docs/superpowers/specs/2026-10-28-ledger-repeat-suppression-design.md](../specs/2026-10-28-ledger-repeat-suppression-design.md)

## Global Constraints

- The ledger is rebuilt from GitHub on every run. It does not read KV. KV stays an optional cache nothing depends on.
- Only high-confidence decisions settle a claim: a reply that declines or defers it, a reply that cites a fixing commit, or a thread resolved by a decider. A later commit touching nearby lines does not settle it. Reactions never settle.
- Deciders are the PR author and any non-bot account whose association is owner, member or collaborator. Other bots and drive-by accounts do not decide.
- Matching has two tiers. Tier 1 is `isSameClaim` with default thresholds and the 30-line window. Tier 2 is same path at any distance with title similarity 0.7, or 0.5 when an identifier is shared.
- Only settled entries suppress. Open entries do not.
- Fail open: if the ledger cannot be built, nothing is suppressed, the error is logged, and the footer says `ledger: cold`.
- The ledger outranks KV: prior open findings the ledger shows as settled are dropped from `survivingPrior` before the verdict.
- Silence: post nothing only when there are no fresh findings after suppression and the bot's previous verdict was not REQUEST_CHANGES. If it was REQUEST_CHANGES and nothing blocking remains, post the APPROVE. A first review with zero findings still posts its APPROVE.
- Withdraw-with-reason is out of scope. `decidedBy: "reviewer"` and a nullable `reason` are reserved only.
- Repo conventions: TypeScript ESM with `.js` import specifiers, named exports only, vitest tests colocated as `*.test.ts`, conventional commits, no ASCII banner comments. `npm run typecheck`, `npm run lint` and `npm run test` must pass before every commit that touches `src/`.

## Review Focus

- Silence returns `null` at a SHA that has no posted review. `watch` and the webhook must treat it like the existing triage SKIP and not re-run the review on every poll. Test: `watchPr` with a `submitReview` that returns null does not call it again for the same head.
- Two generic findings with the same title in different files ("Missing error handling") are different defects. Test: no suppression across files unless both name a common identifier.
- The sister bot's settled threads must not suppress this bot's findings. Test: a settled entry whose comment is not in a `### <commentPrefix>` review is ignored.
- General findings have no path. Test: a settled general finding suppresses a reworded general finding at the unanchored 0.6 bar and does not suppress an unrelated one.
- A long PR has more than one page of review threads. Test: `fetchLedgerEvidence` follows `pageInfo.endCursor` across two pages.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/ledger/types.ts` | `LedgerEntry`, `Ledger`, `LedgerStatus` |
| `src/ledger/disposition.ts` | Shared reply classifier and patterns, used by replay and live |
| `src/ledger/match.ts` | Two-tier settled-claim matching |
| `src/ledger/suppress.ts` | Pure suppression over findings and over an agent review |
| `src/ledger/github.ts` | `buildLedger` (pure), `fetchLedgerEvidence` (Octokit) |
| `src/ledger/live.ts` | Fail-open `loadLedger` used by `buildReview` |
| `src/ledger/file.ts` | `loadLedgerFile` / `saveLedgerFile` |
| `src/replay/label.ts` | Modified: imports the shared classifier |
| `src/replay/pipeline.ts` | Modified: `todaysCodePipeline` becomes the ledger pipeline |
| `src/review.ts`, `src/prompt.ts` | Modified: integration |

### Task 1: Shared reply classifier

**Files:**
- Create: `src/ledger/disposition.ts`, `src/ledger/disposition.test.ts`
- Modify: `src/replay/label.ts` (the `DEFERRED`, `REJECTED`, `FIX_REF` constants and the reply branch of `labelClaim`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface DecisionReply { author: string; createdAt: string; body: string; authorAssociation?: string; isBot?: boolean }
  export interface ReplyDisposition { status: "deferred" | "rejected" | "fixed"; reason: string; evidence: string[] }
  export function classifyReplies(replies: DecisionReply[], isDecider: (r: DecisionReply) => boolean): ReplyDisposition | null
  ```
  Precedence is deferred, then rejected, then fixed, exactly as `labelClaim` has it today. `evidence` entries are `<createdAt>|<body>` (`unknown|<body>` when `createdAt` is empty). `reason` is the first matching reply's body.

- [ ] Step 1: Write failing tests in `disposition.test.ts`: `classifyReplies` returns `deferred` for "out of scope, follow-up PR", `rejected` for "intentional" and "kept as is", `fixed` for "fixed in a1b2c3d4" and not for "fixed in 2024"; deferred wins over rejected when both match; a reply failing `isDecider` is ignored; no matching reply returns null.
- [ ] Step 2: Run `npx vitest run src/ledger/disposition.test.ts`. Expected: FAIL, module not found.
- [ ] Step 3: Implement `classifyReplies` by moving the three regexes out of `label.ts` verbatim, exported as `DEFERRED`, `REJECTED`, `FIX_REF`.
- [ ] Step 4: Change `labelClaim` to call `classifyReplies(thread.replies mapped to DecisionReply, (r) => r.author === f.author)` and build the same `ClaimLabel` (`confidence: "high"`, same `evidence` strings). Reaction and hunk branches stay in `label.ts`.
- [ ] Step 5: Run `npx vitest run src/replay`. Expected: all pass with no snapshot change (`git diff --stat src/replay/__snapshots__` is empty).
- [ ] Step 6: Commit `refactor(replay): share reply classification with the ledger`.

### Task 2: Ledger types, matcher, suppressor

**Files:**
- Create: `src/ledger/types.ts`, `src/ledger/match.ts`, `src/ledger/suppress.ts`, `src/ledger/match.test.ts`, `src/ledger/suppress.test.ts`

**Interfaces:**
- Consumes: `isSameClaim`, `DEFAULT_CLAIM_MATCH`, `ClaimLike`, `ClaimMatchOptions`, `claimIdentifiers` from `src/claim-dedupe.ts`.
- Produces:
  ```ts
  export type LedgerStatus = "open" | "fixed" | "rejected" | "deferred" | "resolved"
  export interface LedgerEntry { id: string; round: number; path: string | null; line: number | null; severity: string; title: string; action?: string; status: LedgerStatus; decidedBy: "author" | "reviewer" | null; reason: string | null; evidence: string[] }
  export type Ledger = LedgerEntry[]
  export const isSettled: (e: LedgerEntry) => boolean            // status !== "open"
  export const CROSS_ROUND_MATCH: ClaimMatchOptions               // lineWindow Infinity, titleSimilarity 0.7, identifierSimilarity 0.5, unanchoredSimilarity 0.6, minTokens 3
  export function findSettledMatch(f: ClaimLike, ledger: Ledger): LedgerEntry | null
  export interface Suppressed<T> { finding: T; entry: LedgerEntry }
  export function suppressSettled<T extends ClaimLike>(findings: readonly T[], ledger: Ledger): { kept: T[]; suppressed: Suppressed<T>[] }
  export function suppressInReview<R extends { event: string; general_findings: ClaimLike[]; inline_comments: ClaimLike[] }>(review: R, ledger: Ledger): { review: R; suppressed: Suppressed<ClaimLike>[] }
  ```
  `findSettledMatch` tries tier 1, then tier 2, then the moved-file rule: different non-null paths, equal trimmed lowercase titles, and at least one shared `claimIdentifiers`. It considers settled entries only. `suppressInReview` returns a copy; if the review had `event: "REQUEST_CHANGES"` and findings before but none after, `event` becomes `"COMMENT"`.

- [ ] Step 1: Write failing tests. `match.test.ts`: a reworded repeat 12 lines away matches at tier 1; the same claim reworded and 400 lines away with a shared identifier matches at tier 2; "`loadUser` leaks credentials after timeout" at line 10 versus "`loadUser` leaks connections after timeout" at line 500 returns null; identical title "Missing error handling" in two files with no shared identifier returns null; identical title in two files sharing `fetchUser` matches; an `open` entry never matches; a general finding (path null) matches a reworded general entry and not an unrelated one. `suppress.test.ts`: kept order preserved; `suppressInReview` downgrades REQUEST_CHANGES to COMMENT only when everything was suppressed, and leaves it when one finding survives.
- [ ] Step 2: Run `npx vitest run src/ledger`. Expected: FAIL.
- [ ] Step 3: Implement the files per the signatures above. Tier 2 reuses `isSameClaim` with `CROSS_ROUND_MATCH`.
- [ ] Step 4: Run `npx vitest run src/ledger` then `npm run typecheck && npm run lint`. Expected: PASS.
- [ ] Step 5: Commit `feat(ledger): cross-round settled-claim matching and suppression`.

### Task 3: Replay pipeline and negative pairs

**Files:**
- Modify: `src/replay/pipeline.ts` (`todaysCodePipeline`), `src/replay/fixtures/*.labels.json` (`negativePairs` only)
- Create: `src/replay/pipeline.test.ts`

**Interfaces:**
- Consumes: `LedgerView`, `ReplayPipeline` (same file); `Ledger`, `suppressSettled` from Tasks 2; `visibleLabels` output already in `LedgerView.labels`.
- Produces: `todaysCodePipeline: ReplayPipeline`. It builds a `Ledger` from `ledger.priorClaims` joined to `ledger.labels`, keeping only labels with `confidence === "high"` and `label` in fixed, rejected, deferred; entry `status` is the label, `decidedBy: "author"`, `reason` is the first evidence text. It runs `suppressSettled` on `input.claims` and returns ids.

- [ ] Step 1: Write failing tests in `pipeline.test.ts` using `makeFixture`, `makeLabel`, `makeLabels` from `testkit.ts`: a round-1 claim repeating a round-0 claim labeled `rejected`/`high` with visible evidence is suppressed; the same with a `low`-confidence label is posted; a repeat whose evidence is timestamped after the round cutoff is posted (no hindsight); round-0 claims are never suppressed. Then one test per real fixture in `src/replay/fixtures/` (all six): run `replayFixture` with `todaysCodePipeline`, assert `checkRecall(...).failures` is empty and `computeMetrics(...).recycled.count` is 0.
- [ ] Step 2: Run `npx vitest run src/replay/pipeline.test.ts`. Expected: the synthetic tests FAIL (pipeline posts everything); the fixture tests FAIL on `recycled.count > 0` where confirmed repeats exist. Also run the CLI (`src/cli.ts`, subcommand `replay`) now and save its output to the scratchpad as the baseline, since the default pipeline still posts everything.
- [ ] Step 3: Implement `todaysCodePipeline` per the interface. `asRecordedPipeline` is unchanged.
- [ ] Step 4: Mine negatives. In the scratchpad directory (not committed), write a throwaway script that runs `findSettledMatch` over every cross-round claim pair in the six fixtures and lists pairs it joins that are not confirmed in `repeatPairs`. Classify each pair against the claim text with a subagent, then cross-check with `codex:codex-rescue`. Add true negatives to the matching `negativePairs` arrays. Report the count of pairs the two models disagree on in the PR body; do not hand them to a person.
- [ ] Step 5: Run `npx vitest run src/replay`. If `checkRecall` reports a negative pair lost, raise the tier 2 thresholds in `CROSS_ROUND_MATCH` until it passes, then rerun `src/ledger` tests.
- [ ] Step 6: Run the CLI replay again and keep the `recycled` and `restated open` lines from both runs for the PR body.
- [ ] Step 7: Commit `feat(replay): ledger suppression as the default replay pipeline`.

### Task 4: Ledger from GitHub

**Files:**
- Create: `src/ledger/github.ts`, `src/ledger/github.test.ts`

**Interfaces:**
- Consumes: `classifyReplies`, `DecisionReply` (Task 1); `LedgerEntry`, `Ledger` (Task 2); `splitInlineClaims` from `src/replay/claims.ts`; `parseBodyFindings` from `src/review-state.ts`; `PostedClaim` from `src/replay/types.ts`.
- Produces:
  ```ts
  export interface EvidenceThread { commentId: number; isResolved: boolean; resolvedBy: string | null; replies: DecisionReply[] }
  export interface LedgerEvidence { prAuthor: string; claims: PostedClaim[]; threads: EvidenceThread[] }
  export function buildLedger(e: LedgerEvidence): Ledger
  export function fetchLedgerEvidence(octokit: { request: OctokitLike["request"] }, o: { owner: string; repo: string; pull: number; commentPrefix: string }): Promise<LedgerEvidence>
  ```
  `buildLedger`: one entry per claim; decider is `r.author === prAuthor` or association in OWNER/MEMBER/COLLABORATOR and not `isBot`. A classifying decider reply sets status and reason. Otherwise a thread with `isResolved` and `resolvedBy` equal to a decider login (prAuthor, or a login seen as a collaborator in any reply) gives `resolved`, reason null. Otherwise `open`. `decidedBy` is `author` when settled. `round` is `claim.roundIndex`.
  `fetchLedgerEvidence`: reviews via REST; own reviews are those whose body contains `### ${commentPrefix}`; claims come from comments whose `pull_request_review_id` is an own review (inline via `splitInlineClaims`, body via `parseBodyFindings`), with ids `r<index>:c<commentId>:<k>` and `r<index>:body:<k>` as in `src/replay/record.ts`; threads via one paginated GraphQL call (`octokit.request("POST /graphql", { query, ...vars })`) selecting `isResolved`, `resolvedBy { login }`, comments with `databaseId`, `author { login __typename }`, `authorAssociation`, `body`, `createdAt`, and the PR `author { login }`. Only threads whose first comment is an own-review comment are kept.

- [ ] Step 1: Write failing tests for `buildLedger`: a collaborator's "intentional" reply settles as `rejected` with that reply as `reason`; a drive-by account's identical reply does not; a bot reply does not; an author-resolved thread with no reply gives `resolved`; a thread resolved by a non-decider stays `open`; a reaction-only thread (no field for it) stays `open`; the sister bot's claim (comment not in an own review) is absent from the ledger. For `fetchLedgerEvidence` with a fake `request`: two GraphQL pages are both read, and a thread whose first comment is not an own-review comment is dropped.
- [ ] Step 2: Run `npx vitest run src/ledger/github.test.ts`. Expected: FAIL.
- [ ] Step 3: Implement both functions per the interfaces.
- [ ] Step 4: Run `npx vitest run src/ledger && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] Step 5: Commit `feat(ledger): rebuild the ledger from review threads`.

### Task 5: Suppression inside buildReview

**Files:**
- Create: `src/ledger/live.ts`, `src/ledger/live.test.ts`
- Modify: `src/review.ts` (`buildReview`, `formatReviewBody` options, `PullRequestReview` interface), `src/prompt.ts` (`PromptContext.priorOwnFindings` and its renderer), `src/review.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4; `agentResults` and `mergeReviewsDetailed` call and `survivingPrior` in `buildReview`.
- Produces:
  ```ts
  export interface LoadedLedger { ledger: Ledger; warm: boolean }
  export function loadLedger(octokit, o: { owner: string; repo: string; pull: number; commentPrefix: string }): Promise<LoadedLedger>   // never throws; on error logs and returns { ledger: [], warm: false }
  export function reconcileSurvivingPrior(prior: PersistedFinding[], ledger: Ledger): PersistedFinding[]   // drops entries findSettledMatch matches
  ```
  `PullRequestReview` gains `state?: string`. `formatReviewBody` gains optional `ledgerNote?: string`, rendered in the footer as `ledger: warm, N suppressed` or `ledger: cold`. `priorOwnFindings` items gain optional `reason?: string`, rendered as `[declined by author: <reason>]` after the status.

- [ ] Step 1: Write failing tests in `review.test.ts` (existing mocking pattern): a settled repeat in an agent's output is absent from the posted review; one agent returning only suppressed findings no longer yields REQUEST_CHANGES; a KV-open prior finding the ledger shows settled does not force REQUEST_CHANGES; a failing GraphQL call leaves the review intact with footer `ledger: cold`. `live.test.ts`: `loadLedger` swallows a thrown fetch and returns cold; `reconcileSurvivingPrior` keeps unmatched findings. `prompt.test.ts` addition: a settled item renders with its reason.
- [ ] Step 2: Run `npx vitest run src/review.test.ts src/ledger/live.test.ts src/prompt.test.ts`. Expected: new tests FAIL.
- [ ] Step 3: Implement `loadLedger`, `reconcileSurvivingPrior`. In `buildReview`, call `loadLedger` after the files are fetched; map each `agentResults` entry through `suppressInReview` before `mergeReviewsDetailed`; filter `survivingPrior` through `reconcileSurvivingPrior`; append settled ledger entries not already matched by a KV-listed finding to `priorOwnFindings` with their `reason`; log suppressed count; pass `ledgerNote`.
- [ ] Step 4: Run the full suite: `npm run typecheck && npm run lint && npm run test`. Expected: PASS.
- [ ] Step 5: Commit `feat(review): suppress settled repeats in code`.

### Task 6: Silence and verdict transition

**Files:**
- Modify: `src/review.ts` (`buildReview`, after the merge and `finalEvent` inputs are known), `src/review.test.ts`, `src/watch.test.ts`

**Interfaces:**
- Consumes: `existingReviews` with `state` (Task 5), `priorOwnReview`, `restampCheckRun(context, event)`, `allAgentsSucceeded`, `survivingPrior`.
- Produces: `buildReview` returns `null` when all of: `priorOwnReview !== null`, `allAgentsSucceeded`, the merged review has no general findings and no inline comments, `survivingPrior` is empty after reconciliation, and the latest own review in `existingReviews` has `state !== "CHANGES_REQUESTED"`. It calls `restampCheckRun` with `"APPROVE"` if that review's state is `APPROVED`, else `"COMMENT"`, and updates saved KV state's `lastReviewedSha` when KV state exists, as the triage SKIP branch does. When the latest own review is `CHANGES_REQUESTED` and nothing blocking remains, the existing `cleanDelta` path posts the APPROVE unchanged.

- [ ] Step 1: Write failing tests: (a) re-review, previous own review `COMMENTED`, everything suppressed: result is null and the check-run is restamped; (b) same with previous `CHANGES_REQUESTED`: result is an APPROVE decision; (c) first review (no prior own review), zero findings: APPROVE as before; (d) a partial run (one agent errored), zero findings: not null; (e) previous `APPROVED` with a fresh finding: posts normally. In `watch.test.ts`: a `submitReview` returning null for head X is not called again for head X on the next cycle.
- [ ] Step 2: Run `npx vitest run src/review.test.ts src/watch.test.ts`. Expected: (a) FAILs (posts an APPROVE today), watch test FAILs or passes; if it already passes, keep it as a pin.
- [ ] Step 3: Implement the guard. Identify "latest own review" by body containing `### ${context.commentPrefix}`, last in list order.
- [ ] Step 4: Run `npm run typecheck && npm run lint && npm run test`. Expected: PASS.
- [ ] Step 5: Commit `feat(review): post nothing when a re-review round has nothing new`.

### Task 7: Local file ledger and docs

**Files:**
- Create: `src/ledger/file.ts`, `src/ledger/file.test.ts`
- Modify: `CLAUDE.md` (Key files table: add `src/ledger/` row; one line under Request flow noting the ledger)

**Interfaces:**
- Consumes: `Ledger`.
- Produces:
  ```ts
  export function ledgerFilePath(root: string, owner: string, repo: string, pull: number): string   // <root>/.ai-review/ledger/<owner>__<repo>__<pull>.json
  export function loadLedgerFile(path: string): Promise<Ledger>        // missing file -> []; malformed JSON throws
  export function saveLedgerFile(path: string, ledger: Ledger): Promise<void>   // creates directories
  ```

- [ ] Step 1: Write failing tests: round trip; missing file gives `[]`; malformed JSON throws; path shape.
- [ ] Step 2: Run `npx vitest run src/ledger/file.test.ts`. Expected: FAIL.
- [ ] Step 3: Implement with `node:fs/promises`.
- [ ] Step 4: Update `CLAUDE.md`. Run `npm run typecheck && npm run lint && npm run test`. Expected: PASS.
- [ ] Step 5: Commit `feat(ledger): local file ledger and docs`.

## After the last task

Driven by the main session, not subagents: `npm run typecheck && npm run lint && npm run test`; `ai-review review --full` once on the branch and once on the fix batch, each finding checked against the code; `/no-mistakes` to push and open the PR with the replay before/after numbers and the disagreement count; `/pr-loop` through merge; close `ai-review-bot-w9b.1` and `ai-review-bot-a6a`.
