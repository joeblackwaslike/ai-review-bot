# Review experiments harness, phase 2 plan

Spec: `docs/superpowers/specs/2026-11-05-review-experiments-harness-design.md` (sections 2, 3, 4)

Goal: frozen per-round inputs, a checkout manager for tool-using strategies, and the join-rate
investigation on ai-listings#50.

## Global Constraints

- TypeScript ESM, `.js` import suffixes, named exports only, Biome, Vitest colocated tests.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green before the PR.
- Fixture `schemaVersion` stays 1; any new field is optional.
- The harness never executes code from a checkout (spec section 2).
- OpenAI quota is tight: the investigation makes at most 20 judge calls total and runs once.
- Strategy `a` behaviour does not change; its saved-trace equivalence test stays green.
- Items with unknown timestamps are excluded and counted, never guessed (spec section 3).

## Task 1: Frozen fixture view

Files: create `src/replay/frozen.ts`, `src/replay/frozen.test.ts`; modify `src/replay/strategy.ts`,
`src/replay/live.ts`.

Interfaces:
- Produces `freezeFixture(fixture: ReplayFixture, roundIndex: number): FrozenFixture` where
  `FrozenFixture` holds `owner, repo, pull, provider, author, rounds` (indexes `<= roundIndex`,
  with `trace` stripped), `threads` (replies filtered to `createdAt <= round.submittedAt`,
  `isResolved` recomputed as false when the resolution time is unknown or later),
  `reactions` filtered the same way, and `excluded: { unknownTimestamp: number; later: number }`.
- `StrategyInput.fixture` changes type from `ReplayFixture` to `FrozenFixture`. `live.ts` builds
  it per round.

Steps:
1. Write a test using a fixture with a reply, a reaction and a round planted after round 1;
   assert `freezeFixture(f, 1)` contains none of them and `excluded.later` counts them.
2. Add a test for an item with an unparseable timestamp: excluded, counted in `unknownTimestamp`.
3. Watch both fail, implement, watch pass.
4. Swap the type in `strategy.ts` and the construction in `live.ts`; fix compile errors; run the
   strategy `a` equivalence test.

## Task 2: Checkout manager

Files: create `src/replay/checkout.ts`, `src/replay/checkout.test.ts`.

Interfaces:
- Produces `withCheckout<T>(opts: { owner; repo; baseSha; headSha; cacheDir?; git?: GitRunner },
  fn: (h: CheckoutHandle) => Promise<T>): Promise<T | CheckoutUnavailable>` where
  `CheckoutUnavailable = { unavailable: true; reason: string }`.
- `GitRunner = (args: string[], cwd?: string) => Promise<{ stdout: string }>`, default wraps
  `execFile("git", ...)` (no shell).
- Cache path `~/.ai-review/checkouts/<owner>__<repo>.git` (override via `AI_REVIEW_CHECKOUT_DIR`).
- Uses the base commit already stored on each round (`baseSha`, `mergeBase`); no `--record`
  change is needed because both are recorded today.

Steps:
1. Test against a temp local bare repo built in the test: clone fills the cache, a second call
   fetches instead of cloning, the worktree is at `headSha`, files are not writable, the
   worktree is gone after `fn` returns or throws.
2. Test a `headSha` that does not exist: result is `{unavailable: true, reason}`, no throw.
3. Implement with `git clone --bare` (remote from `gh repo view --json url`, injectable) /
   `git fetch origin <sha>`, `git worktree add --detach`, `chmod -R a-w`, cleanup in `finally`.
4. Verify all three tests pass.

## Task 3: Wire checkouts into the live tier

Files: modify `src/replay/live.ts`, `src/replay/live.test.ts`, `src/replay/command.ts` if the
report text lives there.

Steps:
1. Test: a stub strategy with `needsCheckout: true` receives a non-null `checkout`; with
   `needsCheckout: false` it receives `null` and no clone is attempted.
2. Test: when `withCheckout` reports unavailable, the round is skipped for the tool-using
   strategy, recorded as `checkoutUnavailable`, and the live report prints the per-strategy
   count of rounds it could not run.
3. Implement; keep checkout creation lazy so strategy `a` never touches git.

## Task 4: Join-rate investigation

Files: create `src/replay/join-investigation.ts`, `src/replay/join-investigation.test.ts`,
`docs/review-ontology/join-rate-investigation.md` (the finding).

Interfaces:
- Produces `investigateJoin(opts: { fixture; labels; judge: JoinJudge }): Promise<JoinInvestigation>`
  where `JoinJudge = (c: { candidate; claim; evidence }) => Promise<"same" | "different" | "unclear">`
  and `JoinInvestigation = { pairs: { candidate; claim; verdict; matcherJoined: boolean }[];
  judgeFoundMatcherMissed: number; matcherJoined: number }`.
- A judge must come from the other model family than the candidate's provider (Anthropic
  candidates judged by OpenAI, OpenAI candidates by Anthropic); the function throws if the
  judge's family equals the candidate's.

Steps:
1. Test with a stub judge: pairs pre-filtered to the same path (cap 3 claims per candidate) so
   the call count stays bounded; the stub verdicts produce the expected counts, and
   `matcherJoined` agrees with `isSameClaim` at `JOIN_CLAIM_MATCH`.
2. Test the same-family guard throws.
3. Implement; add a small CLI entry `ai-review replay --investigate-join <fixture-id>` that
   builds the real judge models through `src/auth.ts` (CLI-only) and prints the result.
4. Run it once on ai-listings#50 for both providers (at most 20 calls), write the finding and
   the chosen matcher into `docs/review-ontology/join-rate-investigation.md`.
5. If the judge finds matches the matcher missed, widen the matcher in a follow-up task inside
   this PR (new bead scope), recompute saved `joinRate` figures, and keep 0.33 marked
   provisional. If it finds none, record that the 0 stands.

## Finish

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`; update `CLAUDE.md`'s replay description for
`--investigate-join`; open one PR (spec already merged, so plan and code share this branch).
