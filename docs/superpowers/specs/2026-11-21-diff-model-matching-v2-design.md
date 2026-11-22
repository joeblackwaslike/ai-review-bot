# Design: diff model matching v2

Extends [the diff model](2026-11-15-diff-model-design.md). Read that spec first. This one changes how the model finds code that already existed, and adds one operation type.

## Context

The diff model tells the reviewer what a computed profile found, without changing tier or agent selection. Its relocation matcher finds code that was deleted in one place and added in another, so the reviewer knows the code is old and can focus on what changed inside it.

Joe listed the blind spots on 2026-11-21. Today the matcher misses:

1. A block moved within the same file. It is reviewed as new code.
2. A block of 1 or 2 meaningful lines, other than a one-line declaration matched by name. The floor is 5 lines, or 3 and 4 for a whole definition.
3. A function converted into a method, which changes indentation, name, parameters, types and the `self`/`this` references inside.
4. A Python or YAML block that was re-indented during the move.
5. A block that was moved and then reformatted by the editor on save.
6. A copy. The source stays in place, so nothing was deleted.

## Goals

- Report all six cases as operations in the existing model, with divergences for every line that changed.
- Lower the size floor to one line, with the floor set by how distinctive the code is, not how long.
- Keep the guarantee that an operation never claims more than the checker verified.

## Non-goals

- Copies whose source is outside the patch. A copy of unchanged code that no hunk shows cannot be seen without fetching file contents, and Joe ruled that out on 2026-11-21.
- Semantic equivalence. Two blocks that behave the same but share no tokens are not matched.
- Partial-function moves where the moved lines are interleaved with new code beyond the divergence limits.
- A reformat in place with no move. Detecting it as a mechanical operation is a follow-up.
- Changing `findMovedBlocks()` in `push-shape.ts` or the adaptive-limits path. That is a separate switch.
- Any change to tier or agent selection.

## Anti-goals

- A false relocation. Telling the reviewer that code already existed when it did not removes attention from new code. A missed match costs less than a wrong one, so every threshold below errs toward a miss.
- Saying "safe", "unchanged behavior" or "functional" about any operation. A move into a different class or nesting level can change behavior, and the model reports the change of shape instead.

## What exists today

`src/moved-blocks.ts` splits each file's patch into runs, meaning consecutive deleted or consecutive added lines, and any context line ends a run. It seeds matches by hashing windows of normalized lines, then picks matches largest first. `src/diff-model/relocation.ts` chains seeds, widens each block at its edges while allowing a few differing lines, aligns the two sides, and turns every unaligned line into a divergence. `src/diff-model/declarations.ts` matches one-line declarations by name. `src/diff-model/relocation-check.ts` re-verifies every claim with separate code. The matcher skips pairs in the same file, accepts a seed only at 5 meaningful lines (3 or 4 for a whole definition), and compares lines, so a changed line break breaks a match.

## Approaches considered

A. Keep stretching the line matcher. Same-file moves, smaller blocks and Python re-indent fit. A reformat or a function-to-method conversion does not, because both change which tokens share a line. Smallest change, and it stops short of the goal.

B. Add a token-stream matcher beside the line matcher (chosen). It compares tokens with line breaks, indentation, trailing commas and quote style normalized away, and decides how much a small match is worth by how distinctive its tokens are. The line matcher stays as the first pass, so everything that matches today keeps matching.

C. Parse syntax trees with tree-sitter. Best for function-to-method. It adds a native or wasm dependency per language, which costs bundle size and cold start on Vercel. Rejected.

Joe chose B on 2026-11-21 and asked for all six cases, delivered as stacked PRs.

## Design

### Delivery

Three stacked PRs, each shippable alone behind the existing `REVIEWER_TUNING.diffModel` switch.

| PR | Contents |
| --- | --- |
| A | Same-file moves. Distinctiveness-based acceptance for small blocks, down to one line. |
| B | Token-stream comparison. Reformat after a move. Uniform re-indent for Python and YAML. |
| C | Function-to-method conversion. The `copy` operation. |

Each PR extends `verifyRelocation` for the equivalences it adds, adds seeds, and re-runs the false-positive measurement.

### PR A: same-file moves and small blocks

**Same-file moves.** Each run records the change region it belongs to: the stretch of consecutive `-` and `+` lines between two context lines or hunk boundaries. A deleted run and an added run in the same file may pair only when they are in different regions. Two runs of one region are an ordinary edit of one spot. `findRelocations` passes an `allowSameFile` option to the shared matcher. `findMovedBlocks()` does not, so `push-shape.ts` is unchanged.

A short same-file seed (1 to 4 counted lines) also needs its two sides in different hunks. Git splits hunks only after 3 context lines, but a line that is deleted and re-added within one hunk is nearly always a misaligned diff, not a move. The 150-commit measurement found `src/reviewers.ts` of `32a55e79` (a `return` left behind when a loop was extracted) and a one-line `ITEMS = []` declaration in the REL-10/clean seed reported as moves for that reason. The one-line declaration pass pairs a declaration within one file only across different hunks, so a declaration moved inside one file is reported when its two lines sit in different hunks and never when they share one. Lockfiles, minified bundles and snapshots (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, any `*.lock`, `*.min.js`, `*.min.css`, `*.snap`) are left out of relocation matching, because regenerating one produced 60 same-file moves in a single commit.

Spans in a same-file operation name the same file on both sides, base lines in `from` and head lines in `to`. The checker applies its own region, hunk and uniqueness rules to same-file claims, listed under Checker.

**Acceptance by distinctiveness.** The line-count floor is replaced. A seed is accepted when its information is high enough and, for short seeds, when it cannot be confused with another.

- A line's information is its count of non-space characters, and a line counts only if it has at least one identifier that is not a keyword, or a string or number literal. A line of only `}`, `)`, `end`, `else` or a bare keyword carries none. An import, `require`, `use`, `from ... import` or re-export line carries none, because imports are reshuffled in nearly every refactor. A line that is only a string or number literal carries none.
- A seed of 5 or more counted lines keeps today's rule.
- A seed of 1 to 4 counted lines is accepted when its total information is at least 30 non-space characters and it is unique: its normalized text, all lines joined, occurs at most once among the deleted runs and at most once among the added runs of the whole change.
- A whole definition (opener keyword, closer, as today) is accepted at any length from 1 line with at least 40 non-space characters, and it must pass the same uniqueness test. Several identical helper definitions in a change therefore never pair.

Measurement tightened the 1 to 4 line rule in two ways. A short seed within one file needs 50 non-space characters of information instead of 30: `render.test.ts` of `229b796f` (`expect(r.fileNotes.size).toBe(0);`, 31 characters) and `src/reviewers.ts` of `32a55e79` (41 characters) were alignment artifacts. A short seed whose first line continues an expression (a leading `.name`, `?`, `:`, `??`, `?.`, `=>`, `+`, `,`, `&&` or `||`) is rejected in both the same-file and cross-file cases, because it is not a self-contained block: `996b67e0` reported two lines of a method chain, copied into a test helper, as a move. The checker applies the same tests on its own.

The one-line declaration pass in `declarations.ts` stays. It matches by name and tolerates a changed value, which the content rule cannot. Review of the branch found it too loose, and it now pairs two lines only when the name has at least 3 characters, both files are in one extension family (the script family `js jsx mjs cjs ts tsx mts cts`, the native family `c h cc cpp hpp`, or one extension alone, which also keeps indentation sensitivity equal), and either the text is equal after whitespace squeeze or at least half of the right-hand-side tokens are shared. A constant whose value alone changed (`= 3` to `= 30`) makes no claim, and `type Props = { label: string };` in one file never pairs with an unrelated `type Props` in another. Each pair draws one candidate from the work budget.

**Continuation and uniqueness hardening.** Review found false claims that the first measurement could not, and the rules moved again toward a miss.

- A short candidate (under 5 counted lines) and a one-line declaration fail when the statement may continue past them. That holds when the last line ends in an operator or an opening bracket (outside indentation-sensitive and prose files), when the next line on either side starts mid-statement, meaning a leading operator or a closing bracket indented deeper than the last line, and, outside indentation-sensitive and prose files, when a line follows a last line that does not end in `;`, `}`, `]`, `)`, `,` or `>`, or in the words `end`, `fi`, `done` or `esac`. The next line is the following line of the run, or the context line after it, so `const approved = users` followed by a differing `.filter(...)` line is never reported as an exact one-line move.
- A candidate whose first line begins with a closing bracket or a leading operator (`.`, `?`, `:`, `,`, `=`, `^`, `%`, `&`, `|`, `*`, `+`, `-`, `/`) fails, so `} else if (user.isAdmin && flags.betaAccess) {` never seeds. Indentation-sensitive and prose files keep only the narrower list of chained-call and ternary starts, because they use `-`, `*` and `+` for list items.
- A pair within one file, of any size, needs its text to occur once among the deleted runs and once among the added runs. A paragraph re-indented in two regions of one file therefore cannot be paired across them.
- A line over 2000 characters carries no information and never seeds a short block. The literal pattern is quadratic on a crafted line, 1.3 s at 40 KB and 5.5 s at 80 KB, and the cap removes that.
- A seed of 5 or more counted lines no longer draws the token and candidate pools. Earlier junk could otherwise empty them and reject a later legitimate block. The cells pool still applies to its alignment.

**Cost guard.** Seeds of 1 to 4 lines are indexed by their joined normalized text, and any text that occurs more than once on either side is skipped, so repeated code never creates candidates.

### PR B: token streams, reformat, re-indent

**Token stream.** Each changed run is tokenized with a new pattern, keeping a map from each token back to its source line. The existing `TOKEN` pattern reads any operator character as its own token, so it cannot tell `a + ++b` from `a++ + b`. The new pattern matches whole multi-character operators, longest first (`===`, `>>>=`, `++`, `->`, `::`, `=>`, `**`, `&&=` and the rest of each language class's operator set), so those two lines produce different streams. That pair is a required negative test for the matcher and for the checker. Two blocks are exact when their token streams are equal after the normalizations below. A line joins a match only when all of its tokens fall inside the matched range, so a line shared between a matched and an unmatched statement (`} else {`) stays out and spans stay whole-line spans.

**Two newline classes by file type.**

- Free-newline languages (JS, TS, Java, C, C++, C#, Rust, PHP, CSS and similar): line breaks carry no meaning, so they are dropped from the stream. A line break after `return`, `throw`, `break`, `continue` or `yield` is kept, because it changes meaning in JS.
- Line-significant languages (Python, Ruby, Go, shell, YAML, Kotlin, Swift, Lua) and any unknown extension: a line break is kept unless it falls inside brackets that are still open. Raw lines are first grouped into logical lines by bracket depth outside strings.

**Allowed normalizations.** Whitespace and, in free-newline files, line breaks. A trailing comma before a closing bracket. A trailing semicolon in JS and TS. A single-quoted string against a double-quoted one in JS, TS and Python, only when the content has no quote, backslash or interpolation marker. These are what Prettier, Black and Biome change. Anything else that differs is a divergence.

**Safety.** The lexical-safety check is split in two. Literal-context safety (backtick templates, triple quotes, heredocs, ambiguous `/`) applies to every file: a block that fails it is compared by raw lines only, as today, so a reformat there goes unmatched. This is deliberate. Indentation sensitivity is a separate property, handled by the re-indent rule below instead of forcing raw comparison.

**Re-indent.** For indentation-sensitive files (Python, YAML, Makefile), each block's lines are compared by indentation relative to the block's smallest indent. A block whose relative shape is equal on both sides is exact, whatever the absolute shift. The rule applies only when the block is literal-safe and indented with spaces throughout. A block with tabs, or with tabs mixed with spaces, is compared by raw lines. The operation records the shift as `shape.reindent` (head minus base, in columns) so the renderer can say "moved one level deeper".

**Candidate discovery.** The token pass runs after the line matcher and only on lines the line matcher left unclaimed. It hashes 8-token windows of each run's stream and skips any window that occurs more than twice on either side. Windows that match across a deleted and an added run are merged into maximal token ranges. A range becomes a candidate block when it covers at least one whole line (rule above) and passes the PR A acceptance rule. Competing candidates are resolved largest first, as `selectMatches` does. Because seeds come from body tokens, a block is found even when no whole line survives a reformat unchanged. The declaration pass and then the copy pass run after it, each only on unclaimed lines.

**Budget.** One work budget covers a whole change, counted in work units instead of time so the same input always gives the same output: characters of short seeds compared, candidates created and alignment cells filled. The limits are 200,000 characters (the `tokens` pool counts non-space characters), 5,000 candidates (short seeds and one-line declaration pairs) and 16,000,000 alignment cells in total (the existing per-alignment cap becomes this shared pool). The checker does not draw from the pool, and stays linear by scanning the patches once per batch of claims. When the budget runs out, the matcher stops and returns the operations it has already found. Nothing counts the work that was cut off, and `droppedClaims` only counts claims the checker rejected, so exhaustion truncates silently. The 2,000 ms post-hoc cap in `review.ts` stays as a backstop. Tests include two adversarial inputs, thousands of unique one-line moves and many repeated copy candidates, and assert the budget holds.

### PR C: function-to-method and copies

**Reshape normalization.** Two blocks that open with a definition are compared as signature plus body.

- Discovery is from body tokens (PR B). The signature is then found by walking up from the matched body on both sides: the opening logical line (bracket depth decides where it ends, so a four-line parameter list is one signature) and any decorators or attributes directly above it (`@name` lines in Python, `#[...]` in Rust). The two signatures are paired however different the name, parameters and types are. Each physical line of either signature becomes one divergence of the new class `signature`, with its original text. The checker derives these boundaries from the patch text itself, not from the matcher's segmentation.
- A `self.`, `this.`, `cls.` or `Self::` prefix may be removed from one side to nominate a match. It never hides a change. Every body line that matched only because of the prefix rule becomes a divergence of the new class `receiver`, with the original text. A call that gained `this.` can resolve to different code, so the reviewer sees each such line. `receiver` lines are excluded from the divergence limit, and a block with any of them has a review weight of at least 1.
- Indentation uses the PR B rule.

**The `copy` operation.** A block added in the head that matches other code which still exists in the head.

- The source is either a run of unchanged context lines that a hunk shows, or another added block in the same change. Both are head-side spans. `Operation.shape.sourceNew` is true for the second kind.
- Only a context source shows that the code already existed. A block copied from another added block is a duplicate: both occurrences are new, and a defect in one is a defect in both. The renderer says so, and its review weight is not discounted. It is the larger of 1 and the divergence count.
- A source of context lines can only be as large as the hunk's context, so large copies of unchanged code stay invisible. The renderer says "source visible in this diff only".
- A copy match runs after relocation and only on lines no relocation claimed.
- Duplicates are normal in code (test setup, repeated handlers), so the copy floor is the old one: 5 counted lines, or a 3-line whole definition. The 1 to 4 line distinctiveness rule does not apply.
- Divergences work as for relocation, so a copied block with edits lists them.
- `Operation.type` gains `copy`. A copy has `from` and `to` spans that are both on the head side. Its `reviewWeight` is its code and signature divergences, as for relocation.

### Types

```ts
type OperationType = "relocation" | "rename" | "mechanical" | "copy";
type DivergenceClass =
  | "comment-only" | "rename" | "signature" | "receiver" | "code";

interface Operation {
  // existing fields unchanged
  shape?: { reindent?: number; sourceNew?: boolean };
}
```

### Checker

`verifyRelocation` is extended in each PR with its own implementation of the new equivalence, not a call into the matcher. A claim it cannot confirm is dropped and counted in `droppedClaims`, as now. It must confirm, per PR:

- A: both spans lie on changed lines on their own sides, and the lines of the two spans are identical after whitespace normalization, apart from listed divergences. The checker also enforces these rules with its own code, read from the patch text and its hunk headers.
  - A claim whose spans share a file must not have its two sides in one change region (one stretch of changed lines between context lines or hunk headers), and the whitespace-squeezed text of each side must occur at most once among the changed runs of all patches.
  - A claim under 5 counted lines fails when any of its lines exceeds 2000 characters, or when its two sides in one file share a hunk.
  - It also fails when a side is one line with unclosed brackets or, in an indentation-sensitive file, ends in a colon; when a side begins with a closing bracket or a leading operator; and when the statement may continue past a side, by the same tests as the matcher (an ending operator or opening bracket, a next line of the patch that starts mid-statement or is a deeper closing bracket, or a following line after a last line with no statement terminator).
  - It then needs 30 non-space characters of information (50 within one file), or a whole definition of at least 40, or a one-line top-level declaration. For that last route the head side must be a one-line top-level declaration of the same name (at least 3 characters, and `FOO == bar` is not a declaration), in the same extension family, with equal text after whitespace squeeze or at least half of the right-hand-side words in common. The text of each side must occur at most once among the changed runs.
- B: the token streams it builds itself are equal, using the same newline class and only the listed normalizations.
- C: a copy's `from` span exists in the head, as an added or context line, a signature divergence covers every physical line of the signature it derives from the patch, and every body line that matches only after receiver removal appears as a `receiver` divergence.

### Rendering

Relocations in the same file read "moved within `file`". `shape.reindent` adds "re-indented N levels". `signature` and `receiver` divergences are listed with the code divergences, each with its original text. A copy reads "copied from <span> (source visible in this diff only)". None of this text says the code is safe or unchanged in behavior. The 12 detailed operations and 6000 character limits stay. Operations rank by type, then claims with a code difference before those without, then lines covered. A one-line move with a code difference is therefore never summarized behind larger exact moves, and exact one-line moves fall below larger ones and are the first to be summarized in the count line. Copies rank below relocations.

## Verification

- Unit tests per matcher change, named by behavior.
- Seeds. New seed families score detection: a same-file reorder, a one-line move, a 2-line definition move, a reformatted move, a Python re-indented move, a YAML re-indented move, a function converted to a method, a duplicated block. The seed count in `detect.test.ts` and every `truth.json` update with them.
- A negative seed per risk: an in-place edit that must not become a same-file move, a repeated line that must not match, a template-literal reformat that must stay unmatched.
- The false-positive measurement over the last 150 commits (`findRelocations` on their git diffs), run before each PR merges. Every operation the new rules add that is not a true move or copy is logged with the commit. The bar is zero such operations at the chosen thresholds. If one appears, the threshold moves toward a miss and the measurement runs again.
- Gates: tests, typecheck, lint, `config:check`, `replay --seeds --check`.
- After PR C, the `a-dm` against `a` replay comparison is still not part of this work.

## Calls made without asking Joe

- Copies are patch-only, as Joe ruled. Context-line sources are included because they cost almost nothing and are labeled as partial.
- Same-file pairs are excluded within one change region. Alternative: allow them and filter by distance. Rejected because every in-place edit would qualify.
- The 1 to 4 line rule requires uniqueness across the whole patch, and the thresholds (30 characters for short seeds, 40 for a one-line definition) are starting values to tune on the measurement.
- Quote-style swaps are limited to JS, TS and Python. Ruby and shell use quotes to switch interpolation.
- Unknown file extensions are treated as line-significant, the stricter class.
- Copies get a higher floor than relocations.
- Short same-file seeds need different hunks and 50 characters of information, and short seeds that continue an expression are rejected, all toward a miss, on the evidence of three false positives in the PR A measurement over the last 150 commits. `229b796f` reported `expect(r.fileNotes.size).toBe(0);` of `render.test.ts` (31 characters), an `expect` line git aligned around an inserted test. `32a55e79` reported `return { ready: missing.length === 0, missing };` of `src/reviewers.ts` (41 characters), a `return` left behind when a loop was extracted. `996b67e0` reported `.split("\n")` and `.find((l) => l.trim())` (32 non-space characters) of `src/replay/claims.ts`, two lines of a method chain copied into `claims.test.ts`.
- Lockfiles and generated files are excluded from relocation matching in `findRelocations` only. `findMovedBlocks()` is unchanged.
- The `signature` and `receiver` divergence classes are new, so a changed signature or a changed call receiver is not buried among comment-only and rename classes.
- The work ships as three PRs, ordered by risk and dependency.

## Left to the builder

- The exact token regex additions for Rust `Self::` and for decorators or attributes.
- How the change region id is stored on `Run`.
- Tuning the information and uniqueness thresholds against the measurement.
- Names and numbering of the new seed families.
- The wording of the new render lines.

## Follow-ups this enables

- Detecting in-place reformats as `mechanical` operations with the PR B token normalization.
- Reading base file contents to find copies of unchanged code, if the cost is ever accepted.
