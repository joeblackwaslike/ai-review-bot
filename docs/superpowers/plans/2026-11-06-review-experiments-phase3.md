# Review experiments harness, phase 3 plan

Spec: `docs/superpowers/specs/2026-11-05-review-experiments-harness-design.md` (section 5 and the
"Judges", "Unresolved items" and "OpenAI quota" rules)

Goal: a blind adjudication pipeline with a verdict cache, so candidates the deterministic join
leaves unmatched get a `real` / `not-real` / `unclear` verdict, plus the fixture audit for missed
defects. No scoring formulas yet: precision and recall belong to phase 5. This phase produces the
verdicts and the counts that go next to every figure.

## Global Constraints

- TypeScript ESM, `.js` import suffixes, named exports only, Biome, Vitest colocated tests.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green before the PR.
- Every test uses a stub judge. No test, and no step of this plan, calls a model API. The Claude
  session is expired and OpenAI quota is rationed; the first real adjudication run is a separate
  action after this PR.
- The judge never sees which strategy, provider or model produced a candidate (blind).
- Judge model families: an Anthropic-produced candidate is judged first by a different Anthropic
  model (strongest available) and cross-checked by OpenAI only for verdicts `real` or `unclear`;
  an OpenAI-produced candidate is judged by Anthropic models only and gets no OpenAI check.
- The OpenAI call cap defaults to 0 and needs an explicit flag; the runner refuses to start a
  call that would pass either cap.
- Verdicts both judges agree on count; disagreements are `unresolved`, reported as a count, and
  never sent to a human. Verdicts without a cross-check are marked `single-family`.
- Cache key is `(fixture snapshot id, normalized claim)`; the same claim from two strategies is
  judged once.
- Judge spend is its own line, outside strategy cost.
- CLI-only: nothing here is imported from webhook paths; auth goes through `src/auth.ts`.

## Task 1: Verdict types, snapshot id, cache

Files: create `src/replay/adjudication/types.ts`, `snapshot.ts`, `cache.ts` and matching tests.

Interfaces:
- `Verdict = "real" | "not-real" | "unclear"`; `Scope = "change" | "moved" | null` (set only for
  `real`).
- `JudgeRecord = { family: "anthropic" | "openai"; model: string; promptHash: string }`.
- `VerdictRecord = { verdict: Verdict; scope: Scope; reason: string; first: JudgeRecord;
  second: JudgeRecord | null; secondVerdict: Verdict | null; status: "agreed" | "unresolved" |
  "single-family" }`.
- `snapshotId(fixture: ReplayFixture): string`: first 16 hex of sha256 over a canonical JSON of
  the fixture with `trace` fields removed, so saving a trace does not change the id.
- `claimKey(c: { path: string | null; title: string }): string`: sha256 over path plus the sorted
  `claimTokens(title)` (reuse `src/claim-dedupe.ts`), so rewording and line moves share a key.
- `VerdictCache` with `get(snapshot, key)`, `put(snapshot, key, record)`; JSONL files under
  `~/.ai-review/adjudication/<snapshot>.jsonl` (`AI_REVIEW_ADJUDICATION_DIR` overrides), write by
  temp file and rename, last record per key wins, unreadable lines skipped and counted.

Steps: red tests for id stability (trace added: same id; label text changed: different id), key
stability (title reworded with the same tokens: same key), cache round trip, corrupt line
skipped, two puts of one key keep the later. Then implement.

## Task 2: Blind judge and family routing

Files: create `src/replay/adjudication/judge.ts`, `judge.test.ts`.

Interfaces:
- `JudgeInput = { claim: { path; line; title; body? }; diffEvidence: string }`. It has no field
  for producer, strategy, provider or model, so a producer name cannot reach the prompt.
- `Judge = (i: JudgeInput) => Promise<{ verdict; scope; reason }>`.
- `buildJudgePrompt(i: JudgeInput): string` and `PROMPT_HASH` (sha256 of the prompt template).
- `modelJudge(model, opts)`: `generateObject` with a zod schema, `maxRetries: 0`, medium effort;
  scope required when verdict is `real`.
- `routeJudges(producer: "anthropic" | "openai"): { first: JudgeSpec; second: JudgeSpec | null }`
  with `JUDGE_MODELS` constants (strongest available Anthropic model for the first judge of an
  Anthropic-produced candidate and for OpenAI-produced candidates; OpenAI model for the second
  judge). Implementer confirms the IDs `src/models.ts` accepts.

Steps: red tests that the prompt for two inputs differing only in a producer-looking string in
the title is identical to the template apart from the claim (no producer data is injected), the
routing table (anthropic: Anthropic first, OpenAI second; openai: Anthropic first, no second),
a `real` verdict without scope is rejected by the schema, and `PROMPT_HASH` changes when the
template changes. Then implement.

## Task 3: Adjudication service with budgets

Files: create `src/replay/adjudication/adjudicate.ts`, `adjudicate.test.ts`.

Interfaces:
- `adjudicate(opts: { snapshot; candidates: AdjCandidate[]; producer; judges; cache;
  caps: { anthropic: number; openai: number }; evidence: (c) => Promise<string> })
  : Promise<AdjudicationResult>`.
- `AdjudicationResult = { verdicts: Map<claimKey, VerdictRecord>; counts: { real; notReal;
  unclear; unresolved; singleFamily; cached; deferred }; spend: { anthropic; openai } }`
  where `spend` counts calls.
- Candidates are deduplicated by `claimKey` before any call; cache hits cost nothing.
- Second judge runs only when the first verdict is `real` or `unclear` and the producer is
  Anthropic; agreement gives `agreed`, disagreement `unresolved`; no second judge or OpenAI cap
  of 0 gives `single-family`.
- A call that would pass a cap is not made: the candidate is counted in `deferred` and left out of
  `verdicts`. A judge error becomes `unclear` with a reason starting `judge error:`, counted, and
  is not cached.

Steps: red tests with stub judges for dedupe (two candidates, one key, one call), cache hit (no
call), the OpenAI-cap-0 path (`single-family`, zero OpenAI calls), the Anthropic cap stopping
mid-list (`deferred` counted), the disagreement path, the OpenAI-produced path (no second judge
ever), and an erroring judge not cached. Then implement.

## Task 4: Fixture audit for missed defects

Files: create `src/replay/adjudication/audit.ts`, `audit.test.ts`.

Interfaces:
- `auditFixture(opts: { fixture; labels; diff: string; judge: AuditJudge; second: AuditJudge |
  null; caps }): Promise<AuditResult>` where the judge lists real defects in the diff that no
  labelled claim covers and each result is `{ path; line; title; body; auditAdded: true }`.
- Candidates that survive the second judge (or that have no second judge, marked
  `single-family`) are stored as audit records in the verdict cache under the snapshot id, with a
  distinct record kind so they cannot be read as candidate verdicts. Splits are `unresolved`.
- Audit results are cached by `(snapshot, claimKey)` like verdicts.

Steps: red tests with stub judges: a defect already covered by a label (by `joinsClaim`) is
dropped, a split is unresolved, a single-family result is marked, a repeat run makes no calls.
Then implement.

## Task 5: CLI entry and docs

Files: modify `src/replay/command.ts`, `command.test.ts`, `CLAUDE.md`; create
`docs/review-ontology/adjudication.md`.

Interfaces:
- `ai-review replay --adjudicate <fixture-id> [--max-anthropic <n>] [--max-openai <n>] [--plan]
  [--audit]`. Candidates are the fixture's distinct saved-trace candidates that `joinsClaim`
  leaves unmatched.
- `--plan` prints how many calls each cap would allow, how many candidates are cached and how
  many would be deferred, and calls no model. `--max-anthropic` defaults to 40, `--max-openai` to
  0. Misuse (path-like id, `--plan` with `--audit`, combined with other mode flags) exits 2; a
  missing fixture exits 1.
- Output: the verdict counts line from Task 3 and the spend line, and the sentence "single-family
  verdicts have no second-model check" whenever that count is above 0.

Steps: red tests for the exit codes and for `--plan` making zero judge constructions (injected
factory); implement; document the pipeline, the cache location, the family rules and the quota
caps in `docs/review-ontology/adjudication.md` (plain prose); add the flag to the replay
paragraph of `CLAUDE.md`.

## Finish

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`; open one PR (spec and plan already on main). The
first real run (`--adjudicate ... --plan` first, then Anthropic-only) is a follow-up that needs
the Claude login.
