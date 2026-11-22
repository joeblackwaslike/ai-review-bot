---
epic: ai-review-bot-t0c
bead: ai-review-bot-yu6
status: draft, awaiting approval
---

# Design: the diff model

## Context

[00-origin.md](../../review-ontology/00-origin.md) describes what a senior reviewer sees in a diff that the bot does not. A function moved from one file to another reads as a deletion in one file and new code in another, so the bot reviews the body as if it had never been seen and skips the checks that matter after a move: stale imports, mocks, test locations and config paths. A lockfile or generated file counts toward the size of the review. A PR description that says "no functional change" is never compared with the diff.

[triage.md](../../review-ontology/triage.md) breaks this into nine dimensions. This spec covers the ones that can be computed from the patches and the PR description alone, with no checkout and no model call: file kind, code role, operation mix, novel versus relocated code, test coupling and stated intent. Domains hit is carried as data. Blast radius and the trust-boundary call graph need references or a language server, so they belong to the reviewer tool-surface spec (bead ai-review-bot-t0c.45).

The result is a diff model, a graph of typed objects built from the PR's patches and richer than the flat diff, plus a renderer that puts a bounded part of it into the reviewer prompt. The diff itself is never edited.

Later work reads the same model. Tier and agent selection can use it in place of line counts and substrings, a tool-calling reviewer can query it, and the replay harness can score it against the seeded fixtures.

## Goals

- Tell the reviewer, as computed facts, which code was relocated, renamed or only reformatted, and which lines inside a relocated block changed.
- Keep every line of the diff, and every line number the reviewer anchors to, exactly as GitHub shows it.
- Scale to PRs with dozens of operations: related facts collapse into one object, and the prompt carries a ranked, size-capped view.
- Be deterministic and testable without a model, and score exactly on the existing seeded fixtures.
- Give later consumers a stable data structure so they don't redo the analysis.

## Non-goals

- Changing the tier, the model, or which agents run. Using the diff model for that is a follow-up spec.
- Tools the reviewer calls to query the model (the tool-surface spec).
- Anything that needs a checkout or a language server.
- A model call to build or enrich the profile.
- Replacing the Tier 2 substring detectors. The model carries domain tags as data, and nothing reads them in this spec.

## Anti-goals

This work fails, even if it technically runs, when any of these happens.

- The reviewer is told a block is unchanged and it is not. A false "unchanged" claim is worse than no claim, because the reviewer will skip the line that matters.
- Any diff line, header or line number the reviewer sees differs from the patch. A finding that anchors to a line GitHub does not show is dropped today, so a shifted number loses real findings.
- The notes turn into a second diff the model has to read. If the section is longer than the problem it describes, it has failed.
- The reviewer treats a computed note as more authoritative than the diff.

## What exists today

- `findMovedBlocks()` in [src/moved-blocks.ts](src/moved-blocks.ts) finds runs of 5 or more matching lines deleted in one file and added in another. It returns file pairs and line counts (`MovedBlock`: `from`, `to`, `lineCount`, `spanLines`). It returns no line ranges and no record of lines that differ inside a block.
- `classifyFile()` and `classifyPush()` in [src/push-shape.ts](src/push-shape.ts) assign each file a `FileKind` (code, test, docs, config, infra, shell, binary, generated, lockfile), detect whitespace-only and rename-only files, and compute a reviewable weight. Only the adaptive limits read them.
- `packDiff()` in [src/diff-pack.ts](src/diff-pack.ts) fits the serialized diff into `REVIEW_DIFF_BUDGET_CHARS`. When the diff is over budget it drops deletion-only hunks, which is the deleted half of a move, and may cut or omit whole files.
- `classifyTier()` ([src/router.ts](src/router.ts)) sees only line counts, file paths and labels. The Tier 2 detectors ([src/tier2.ts](src/tier2.ts)) match substrings against paths and the concatenated patch text.
- `buildUserMessage()` ([src/prompt.ts](src/prompt.ts)) puts the PR metadata and the packed diff in a first block that is cached and shared by all agents. Each agent's skill text follows in an uncached block.

## Constraints

- The packed diff text is byte-identical with the model on or off. A test enforces it.
- The analysis reads full patches, not the packed prompt. A move whose deleted half the packer dropped is still detected, and the note says which lines are not shown.
- It is linear in patch size, with no I/O and no model, so it runs inside the existing function budget.
- The rendered section depends only on the input it describes, so it is identical for every agent that receives the same input and sits in the shared first block, which is cached.
- Everything derived from the author goes through the existing untrusted-text fence helper in [src/prompt.ts](src/prompt.ts), including file names, the PR description, quoted intent phrases, and the original code or comment text shown for a divergence. Each value has a length limit (200 characters, my call). Fixed instructions to the reviewer stay outside the fence. Tests render adversarial values (a closing fence tag, an instruction in a comment or file name).
- If building or rendering throws or exceeds its time cap, the review proceeds without the section and logs why, as the summary call does today.
- On an incremental round, dispatch builds two inputs today: agents with pending skills get the whole PR, and the rest get the delta. The model is built and packed once per input scope, using the same grouping, and each section says which scope it describes. A move whose halves land in different rounds is not seen by the delta group. This is accepted and logged.
- A file GitHub returns without a patch (too large, binary) gets a `FileNode` and a kind, and no operations. The summary counts it as "no patch".

## Approaches considered

1. **Observations list at the top of the prompt.** Simple, but it grows with the PR. At 50 to 100 items the reviewer cannot hold it, and unanchored notes are hard to use.
2. **Notes written into the diff.** Marks each half of a move beside the code. Rejected. It edits the source of truth, puts line-number anchoring at risk, and every later decision would have to remember the diff text is no longer the diff.
3. **A cheap model call that writes the profile.** Handles odd layouts, but adds a call per PR, varies between runs, and makes experiments harder to read. It can be added later as a fallback for what the rules cannot classify.
4. A graph of objects, rendered as ranked text grouped by file (chosen). Related facts become one object, the diff stays untouched, and the same structure serves the later tool surface and tier selection. The first version renders text because today's reviewers have no tools.

Joe chose approach 4 on 2026-11-15, with query tools deferred to the tool-surface spec.

## The model

A pure function builds it.

```ts
buildDiffModel(input: {
  files: PushFile[];
  title: string;
  body: string | null;
}): DiffModel
```

`PushFile` is the existing type in `src/moved-blocks.ts`. The module lives in `src/diff-model/`.

```ts
interface DiffModel {
  files: FileNode[];
  operations: Operation[];
  facts: PrFacts;
}

interface FileNode {
  filename: string;
  previousFilename?: string;
  status: string;
  kind: FileKind;
  role?: CodeRole;
  hunks: HunkRef[];
  shown: "full" | "partial" | "none";
}

interface Span {
  filename: string;
  side: "base" | "head";
  startLine: number;
  endLine: number;
  shown: "full" | "partial" | "none";
}

interface Operation {
  id: string;
  type: "relocation" | "rename" | "mechanical";
  from: Span[];
  to: Span[];
  exact: boolean;
  divergences: Divergence[];
  reviewWeight: number;
}

interface Divergence {
  kind: "changed" | "inserted" | "removed";
  base?: Span;
  head?: Span;
  original?: string;
}

interface PrFacts {
  testsChanged: boolean | "unknown";
  intentClaims: IntentClaim[];
}
```

`FileKind` is the existing type in `src/push-shape.ts`, reused as is. `CodeRole` follows [triage.md](../../review-ontology/triage.md#2-code-role) and is filled only when the path or the visible hunk lines decide it. `shown` records whether the packer put all, part or none of the file in the prompt, so the renderer can say "deleted lines not shown".

An operation carries the spans it covers, a flag for whether the match is exact after whitespace normalization, and its divergences, which are the lines inside a relocated block whose text changed, with the original text.

### Operations in the first version

| Type | Detection | Source |
| --- | --- | --- |
| relocation | Matching runs of deleted and added lines across files, extended to tolerate changed lines inside a run, with the changed lines recorded as divergences | Extends `findMovedBlocks()` |
| rename | `status: renamed` with `previous_filename`, plus content similarity | PR files API data |
| mechanical | Whitespace-only and import-only hunks | A new check that applies the same conservative lexical rule as the relocation checker; a new import-only check |

The model does not take its whitespace-only verdict from `classifyPush()`. That function normalizes line by line with no string context, so a changed space inside a multiline template literal is reported as whitespace-only with zero weight (confirmed by running it). The model emits a mechanical operation only where the conservative check confirms a safe context, and otherwise treats the hunk as ordinary change. The existing `classifyPush()` bug is filed separately and is not fixed here.

Relocation is the hard one. Today a run breaks at the first changed line, so a 40-line move with one edited line matches as two shorter runs, and one may fall under the 5-line minimum. The builder needs a match that finds the pair and then reports differences inside it. Seed REL-10 (a move with one changed comparison) is the acceptance test.

Within a matched pair of spans, the base and head lines are aligned (a longest-common-subsequence alignment over normalized lines). Every line of both spans ends up either matched or in a divergence. A divergence is a `changed` pair, a line that exists only in the head (`inserted`), or a line that exists only in the base (`removed`). A deleted guard inside a moved function is a `removed` divergence, so the head span does not have to contain it.

Normalization has to be conservative. Collapsing whitespace is safe in code and unsafe inside a multiline string or template literal, where it changes a runtime value, and in indentation-sensitive languages. Where the lexical context is unknown, lines are compared raw. A whitespace-only difference outside such contexts is not a divergence. A comment-only difference is its own divergence class. A consistent identifier substitution (the same name replaced the same way everywhere in the block) is a rename class. Anything else is a code class.

The renderer lists code divergences prominently, mentions the other classes in one line, and says "unchanged" about a block only when it has no divergence of any class.

The starting thresholds, to be tuned on the seeds, are a minimum of 5 meaningful lines per match and up to 3 differing lines or 20 percent of the block, whichever is smaller. For a deleted and added file pair that git did not mark as a rename, the content similarity cutoff starts at 0.6.

A second routine checks every relocation claim independently of the matcher. It accounts for every line of both spans exactly once, in one of three ways: an identical pair, a pair that differs only by whitespace in a context the checker itself confirms is safe (outside any string or template literal and outside an indentation-sensitive language), or a listed divergence. It uses raw text where it cannot confirm the context, and it reproduces the divergence set on its own. A claim that fails the check is dropped and counted. Required tests are two negative cases, a multiline template literal whose inner whitespace changed and a moved function with a deleted guard, and a positive case, a move that was only reformatted, which is reported as a relocation with no divergence.

Stated intent is parsed into `intentClaims`, a short list of phrases such as "no functional change", "refactor only" and "rename", each with the PR text span it came from. The renderer pairs a claim with a conflicting operation or a divergence in a moved block.

Signature changes and domain tags are in the model's shape, but the first version fills them only when the patch alone decides them. Otherwise they stay unset. Detecting them properly is listed under follow-ups.

## Rendering

`renderDiffModel(model, limits)` returns text, or an empty string when there is nothing worth saying. It is inserted into the shared first block of the user message, next to the PR metadata.

It has two parts.

The summary at the top is one short paragraph on file mix, such as "14 files: 8 code, 2 docs, 3 generated or lockfiles, 1 migration", followed by the operations ranked by review relevance. Divergences inside relocations rank first, then relocations, renames, and mechanical changes last. At most 12 operations get detail. The rest are summarized as counts per type.

Per-file notes follow. Each file's relevant operations appear as a labeled block placed immediately before that file's diff text. Notes cite head-side line numbers for added code, the numbers the diff shows. Deleted lines carry no number in the diff, so a note cites their base-side numbers, labeled "base lines", which match the `@@` header of the hunk the reviewer can read. The block is separate text. It never sits between diff lines.

The section opens with one fixed paragraph that says the notes are computed from the diff, are not part of it, and lose to it when they disagree. It also says what a move implies for the review: spend the effort on what the move could break and is visible in this diff (import lines, mocks, test and config paths). The agent cannot read other files in this version, so it should say what it could not check and not guess.

### Example

For a PR that moves `applyDiscount` from `src/billing/utils.ts` into `src/billing/charge.ts` and changes one line on the way:

```text
Computed notes (not part of the diff; the diff wins if they disagree)

Operations in this PR, most relevant first:
1. Relocation with one changed line: utils.ts base lines 10-49 (deleted) match charge.ts lines 3-42 (added).
   Changed: charge.ts line 5, the original was `Math.floor(...)`.
Tests: no test files changed.
The description says "no functional change". Operation 1 has a code difference from the original at charge.ts line 5.
```

The `utils.ts` block starts with "Relocated out, base lines 10-49, see operation 1", and the `charge.ts` block with "Relocated in, line 5 differs from the original". The renderer never asserts that a change is functional. It reports that the code differs and lets the reviewer judge.

### Budget

The section has its own character cap (`DIFF_MODEL_BUDGET_CHARS`, default 6000, my call). The cap is separate from `REVIEW_DIFF_BUDGET_CHARS`, so `packDiff()` runs once with the same budget as today and the packed diff does not depend on the section. The prompt grows by at most the cap. If the cap is hit, the renderer drops the lowest-ranked detail first and keeps the counts. When there are no operations and nothing else worth saying, the section is empty and absent.

`FileNode.shown` is read from the packer's output after packing, and the renderer runs after the packer, so the two never depend on each other's size.

## Where it is built

Packing happens privately inside prompt serialization today, and the renderer needs the packer's output to say which spans are visible. So the work introduces a prepared-input step that both prompt builders share.

There are two preparation contracts, because the prompt builders take different inputs.

Patch preparation serves `buildUserMessage()`. `prepareDiffInput({ scopeFiles, prFiles, prFilesComplete, meta, budget })` takes the files in the round's input scope, the whole PR's file list, and a flag saying whether that list is complete. The files carry `previous_filename`, `additions`, `deletions` and the full patches. It returns the packed diff, the diff model, and for each span whether its lines were shown. The model is built from the full patches before packing, and visibility is read from the packed result afterward. The summary goes in the shared metadata part of the first block. A file's notes are separate text inserted before that file's serialized diff, so the original diff bytes are preserved. The prompt builder does no analysis.

Content preparation for `buildAuditUserMessage()` is deferred. An audit takes whole-file content, has no patches and no PR text, so there are no operations to find and no intent claims to read. Production audits therefore pass no section in this version, which matches the original plan of a section of nothing. Its serialization is unchanged. Only the `a-dm` replay strategy supplies a section, through `runAuditPass`.

Test coupling and intent claims describe the whole PR, even when a round's prompt carries only a delta, so they are computed from `prFiles`. When `prFilesComplete` is false, the section says test coupling is unknown. It never says no tests changed. This version reports only whether any test file changed in the PR (`testsChanged`). Mapping each changed source file to its test file needs a per-language matching rule and is a follow-up. Relocation and the other operations are computed over `scopeFiles`. Each sentence in the section says which scope it describes.

Call sites wired in this version are the webhook and scheduled-review path (including the two-scope incremental dispatch) and `watch`. `gate` and `review` reach the reviewer through `runAuditPass`, so they are not wired in this version and are a follow-up. `review.ts` calls `prepareDiffInput`, and `buildUserMessage()` only takes the rendered result.

The replay strategies matter for the experiment. Strategy `a` reaches the model through `runAuditPass`, which wraps the recorded diff as one synthetic `replay.diff` file and uses the audit builder. To exercise the feature there, the replay path takes the per-file patches from `input.files` and the title and body from the seed's `pr.json`, runs patch preparation on them, and passes the resulting section to the audit builder as an opaque string. Without this the replay comparison would not test the feature at all.

## Switch and rollout

A `REVIEWER_TUNING.diffModel` switch in [src/reviewer-tuning.ts](src/reviewer-tuning.ts), off by default. The model is built and logged even when the switch is off, so the replay harness can measure detection before any reviewer sees it. It is turned on only after the replay comparison below.

## Verification

- Unit tests build the model from patches and assert exact spans, divergences and renderings. No model is called.
- The five seeded operations (REL-01, REL-10, DEL-04, REL-03, MEC-01) with their original, v1, v2, v3 and clean variants. A clean control has no defect. It can still contain an operation: the REL-10 control moves `page_bounds` unchanged, and the MEC-01 control is a formatter-only change. Seed truth today holds one defect range or a clean flag, which cannot score detection. Each seed's truth gets an operations list: the expected relocations, renames and mechanical changes, with source and destination spans and divergences. Required: every expected operation is found at the right lines, a clean control's unchanged move is reported with no divergence, no operation appears that truth does not list, and no reviewer finding appears on a clean control. Detection metrics are reported separately from defect-finding metrics.
- A test that the packed diff text is byte-identical with the model on and off, and that anchor validation behaves the same.
- The seeds that test intent claims need a PR title and body. Seeds carry none today, so the REL-10 variants get a description ("no functional change" on a move that changes a comparison), stored next to `truth.json`.
- A replay comparison, as a strategy variant of `a` in the experiments harness. The pilot is directional because the pilot fixtures give no verdict. The measures are precision and recall on the seeds, wrong findings on lines that only moved, and prompt tokens, which are reported with no threshold.
- The model is built for every PR in the existing fixtures. Each relocation it claims is checked by the second routine described above, and the claims that fail the check are reported as a count. The counts are logged, so false relocations on real code show up before the switch is turned on.

## Follow-ups this enables

- Tier and agent selection read the model instead of line counts and substrings.
- The reviewer tool surface exposes queries such as `moved_code` over the same objects.
- Head-file fetching to fill `role` for files where the hunk does not show the imports.
- Signature and interface change detection, and domain assignment by role.
- Per-file source-to-test mapping, so a changed module with no changed test can be named.
- Content preparation for audits, if audits ever carry PR text.
- Wiring `gate` and `review`, which reach the reviewer through `runAuditPass`.
- Blast radius and trust-boundary reachability, once a checkout or language server is available.

## Calls made without asking Joe

- The module name `src/diff-model/`, and the type names above.
- The default section cap of 6000 characters and the cap of 12 detailed operations.
- A separate section budget on top of the diff budget, so the packed diff is the same with the model on or off.
- Citing base-side line numbers for deleted code, labeled as such.
- The divergence kinds and the starting match thresholds.
- Never asserting that a difference is functional. The renderer reports a code difference.
- Patch preparation (`prepareDiffInput`, which builds the model before packing and reads span visibility after). Content preparation for audits is deferred.
- Test coupling reported as unknown when the PR file list is incomplete.
- One model per input scope on incremental rounds, with test and intent facts computed over the whole PR file list.
- Conservative normalization with raw comparison where the lexical context is unknown, and an independent line-accounting check on every relocation claim.
- An operations list in each seed's truth, and clean controls that may contain an unchanged operation.
- Adding a PR description to the REL-10 seeds.
- Stage order. Relocation, rename, whole-file and import-only mechanical changes, test coupling and intent claims come first. Signature changes and role from fetched files come later.
- Logging the model for every PR while the switch is off.

## Left to the builder

- The relocation match algorithm, within the requirements above.
- How import-only hunks are recognized per language, starting with TypeScript and Python.
- The exact wording of the fixed paragraph, tested against the seeded fixtures.
