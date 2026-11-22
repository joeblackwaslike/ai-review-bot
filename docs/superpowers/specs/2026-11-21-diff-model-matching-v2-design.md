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
- A seed of 5 or more counted lines draws one candidate from the budget but no characters, so earlier junk cannot starve it and the candidate cap still bounds the operations.
- A seed of 1 to 4 counted lines is accepted when its total information is at least 30 non-space characters and it is unique: its normalized text, all lines joined, occurs at most once among the deleted runs and at most once among the added runs of the whole change.
- A whole definition (opener keyword, closer, as today) is accepted at any length from 1 line with at least 40 non-space characters, and it must pass the same uniqueness test. Several identical helper definitions in a change therefore never pair.

Measurement tightened the 1 to 4 line rule in two ways. A short seed within one file needs 50 non-space characters of information instead of 30: `render.test.ts` of `229b796f` (`expect(r.fileNotes.size).toBe(0);`, 31 characters) and `src/reviewers.ts` of `32a55e79` (41 characters) were alignment artifacts. A short seed whose first line continues an expression (a leading `.name`, `?`, `:`, `??`, `?.`, `=>`, `+`, `,`, `&&` or `||`) is rejected in both the same-file and cross-file cases, because it is not a self-contained block: `996b67e0` reported two lines of a method chain, copied into a test helper, as a move. The checker applies the same tests on its own.

The one-line declaration pass in `declarations.ts` stays. It matches by name and tolerates a changed value, which the content rule cannot. It now pairs two lines only when the name has at least 3 characters, both files are in one extension family (`js jsx mjs cjs ts tsx mts cts` count as one), and either the text is equal after whitespace squeeze or at least half of the right-hand-side tokens are shared. A constant whose value alone changed (`= 3` to `= 30`) makes no claim. Each pair draws one candidate from the work budget.

**Continuation and uniqueness hardening.** Review found false claims the first measurement missed, so the rules moved again toward a miss.

- A short candidate (under 5 counted lines) or one-line declaration fails when its statement may continue. That holds when the brackets of the whole span do not balance (a signature may end in `{`); when the span has an odd count of backticks, `"""` or `'''`; when its last line, minus a trailing `//` or `#` comment, ends in an operator, opening bracket or backslash; when the last line is a decorator or attribute (`@name`, `#[`); when it starts a control statement (`if`, `while`, `for`, `case`, `def`, `class`, `function` and similar, except in indentation-sensitive files) without ending in `;` or `}`; when the next line (in the run, or the context line after it) is indented deeper than the last line; and when the next line starts with a leading operator, `as`, `satisfies`, `instanceof`, `in`, `(`, `[` or a backtick, or is a closing bracket. Outside indentation-sensitive and prose files it also holds when a line follows a last line that does not end in `;`, `}`, `]`, `)`, `end`, `fi`, `done` or `esac`. In prose files an odd number of code fence lines in the span is open. Completeness is a text heuristic, since lines alone cannot prove a statement ends, and it misses layouts these tests do not name.
- A first line that begins with a closing bracket or leading operator fails, so `} else if (a && b) {` never seeds. Item-listing files keep only chained-call and ternary starts.
- A same-file pair of any size needs unique text on each side, so a paragraph re-indented in two regions never pairs across them. The scan stops after 50 sites of the first line and calls the text not unique.
- A short seed is skipped when its file's patch text contains a backtick, a triple quote or a heredoc opener, the literal-risk skip `operations.ts` already uses, because a candidate row can sit inside a multi-line literal whose opener is out of view. The checker applies its own copy of the test to every file of the claim.
- A one-line declaration name counts every line that declares it, eligible or not, so a multi-line declaration of the same name blocks the pair. The checker counts declared names in the patches the same way.
- A line over 2000 characters never seeds a short block (the literal pattern is quadratic).
- A seed of 5 or more counted lines draws one candidate but no characters from the budget, so earlier junk cannot starve it and the candidate cap bounds the operations.

**Cost guard.** Seeds of 1 to 4 lines are indexed by their joined normalized text, and any text that occurs more than once on either side is skipped, so repeated code never creates candidates.

### PR B: token streams, reformat, re-indent

**Token stream.** Each changed run is tokenized with a new pattern, keeping a map from each token back to its source line. The existing `TOKEN` pattern reads any operator character as its own token, so it cannot tell `a + ++b` from `a++ + b`. The new pattern matches whole multi-character operators, longest first (`===`, `>>>=`, `++`, `->`, `::`, `=>`, `**`, `&&=` and the rest of each language class's operator set), so those two lines produce different streams. That pair is a required negative test for the matcher and for the checker. Two blocks are exact when their token streams are equal after the normalizations below. A line joins a match only when all of its tokens fall inside the matched range, so a line shared between a matched and an unmatched statement (`} else {`) stays out and spans stay whole-line spans.

**Two newline classes by file type.**

- Free-newline languages (JS and TS): a line break is dropped only when it is obviously a wrap. The previous token must open, separate or continue an expression (`,`, `(`, `[`, `{`, `;`, `}`, `=>`, `.`, `?`, `:`, a binary or assignment operator) or the next token must close or continue it (`)`, `]`, `}`, `.`, `,`, `;`, `?`, `:`, `=>`, a binary operator, `{`). Any other break is kept, so `const a = 1` / `const b = 2` never equals `const a = 1 const b = 2`. A break after a restricted-production keyword (below) is always kept, and so is one before a line that automatic semicolon insertion could make a new statement.
- Line-significant languages (Python and Go): a line break is kept unless it falls inside parentheses or square brackets that are still open. Lines are grouped into logical lines by bracket depth outside strings. In Go a break inside braces is kept even inside open parentheses, because a function literal body is a list of statements. Python does not count braces, so a multi-line dictionary keeps its line break tokens and is never matched across a reflow.
- YAML uses a separate line mode with no tokenizer. Each line, blank ones included, is one token (its text with the indent trimmed), windows are 5 tokens (3 lines, since a `\n` token separates lines), and the relative indent shape is compared as for Python.

**Allowed normalizations.** Whitespace and, in free-newline files, line breaks. A trailing comma before a closing bracket, only where dropping it cannot change meaning. In the JS family it drops when something other than an opener, another comma or a kept line break precedes it. In Python and Go it drops only after a sibling comma, so a one-element tuple keeps its comma, and a comma inside a Python lambda's parameter list is not a sibling. A semicolon in the JS family, only directly before `}` and never after the `)` of an empty `if`, `for`, `for await`, `while`, `switch` or `with` body, nor after `else`, a label or `=>`. A single-quoted string against a double-quoted one in JS (not JSX or TSX, where a quote in text is content), TS and Python, only when the content has no quote, backslash or interpolation marker. These are what Prettier, Black, gofmt and Biome change; anything else is a divergence. Operators come from a per-language table; `<-` exists only for Go.

**Safety.** The lexical-safety check is split in two. Literal-context safety (backtick templates, triple quotes, heredocs, ambiguous `/`) applies to every file: a block that fails it is compared by raw lines only, as today, so a reformat there goes unmatched. This is deliberate. Indentation sensitivity is a separate property, handled by the re-indent rule below instead of forcing raw comparison.

The token pass adds these guards, each backed by a false equivalence a reviewer found while it was built.

- **Eligibility allowlist.** Token mode covers `js jsx mjs cjs ts tsx py pyi go`. YAML (`yml`, `yaml`) uses line mode. Every other extension, Java, C, C++, C#, Rust, Kotlin and Dart included, skips the pass and keeps the line matcher, and so do unknown extensions. Review kept finding false exact matches where raw strings, generics and preprocessors look like operators. The checker has its own copy, pinned equal by a test.
- **Same extension family.** A deleted and an added block pair only when their extensions are in one family (`ts` with `tsx`, `js` with `mjs`, `py` with `pyi`, `yml` with `yaml`; never `go` with `kt`).
- **Literal-file skip.** A file whose visible patch text holds a backtick, a triple quote, a heredoc opener, or a line that opens a single or double quote it does not close (a trailing backslash continues the string) is left to the line matcher entirely, because a changed line in it may sit inside a multi-line literal. The checker applies the same rule.
- **Block comments.** A JS, TS or Go file whose patch has a block comment closed without an opener, never closed, or holding a changed line is skipped by both passes.
- **JSX skip.** `jsx` and `tsx` files, and `js`, `mjs` and `cjs` files whose patch text shows a JSX element, closing tag, self-closing slash or fragment, are left to the line matcher, because JSX text is content. A `ts` file cannot hold JSX.
- **Comments.** A line holding a comment never joins a match and cuts the range, because the tokenizer drops comments.
- **Balanced brackets.** A candidate range must have balanced brackets on both sides, so a statement fragment is never claimed.
- **Restricted productions.** A line ending in `return`, `throw`, `break`, `continue`, `yield`, `async`, `type`, `declare`, `abstract`, `namespace`, `module`, `interface`, `enum`, `get`, `set`, `static`, `let`, `await` or a modifier such as `public` keeps its line break.
- **Odd line terminators.** A line holding a carriage return, vertical tab, form feed, U+0085, U+2028, U+2029 or any non-ASCII space, other than one trailing carriage return, is never matched. Whitespace in token equivalence is only space and tab.
- **HTML-like comments and numbers.** A JS line holding `<!--` or `-->` is never matched. Numbers are tokenized whole, so `1.e3` differs from `1 .e3`.
- **Words and nested strings.** Identifiers follow Unicode `ID_Start` and `ID_Continue`. A Python f-string that reuses its own quote inside a replacement field, at any brace depth, is never matched.
- **Regex after a parenthesis or keyword.** A `/` after `)`, or after `default`, `case`, `delete`, `void`, `typeof`, `in`, `of`, `instanceof`, `new`, `throw`, `yield`, `await`, `else`, `do` or `return`, counts as a possible regex literal.
- **YAML.** Every line is a token, blank lines included, so adding or removing a blank line inside a multi-line scalar is a difference. A file whose patch, context included, has a line ending in a block scalar indicator (`|`, `>`, with an indent digit and chomping sign in either order) is skipped, and so are the scalar body and any line with trailing whitespace.
- **Caps.** Lines over 2,000 characters and brackets nested over 200 deep never match.

The checker applies each of these on its own, with its own scanner and tables. Its comma rule also refuses a comma after a kept line break.

**Re-indent.** For the indentation-sensitive files the token pass accepts (Python and YAML; Makefile is outside the allowlist), each block's lines are compared by indentation relative to the block's smallest indent. A block whose relative shape is equal on both sides is exact, whatever the absolute shift. The rule applies only when the block is literal-safe and indented with spaces throughout. A block with tabs, or with tabs mixed with spaces, is compared by raw lines. Continuation lines inside open brackets are free, so a Black rewrap still matches; only the first line of each logical line is compared. The operation records the shift as `shape.reindent` (head minus base, in columns) so the renderer can say ", re-indented one level deeper".

**Candidate discovery.** The token pass runs after the line matcher and only on lines the line matcher left unclaimed. It hashes 8-token windows of each run's stream and skips any window that occurs more than twice on either side. YAML line mode uses 5-token windows (3 lines) instead. Windows that match across a deleted and an added run are merged into maximal token ranges. A range becomes a candidate block when it covers at least one whole line (rule above) and passes the PR A acceptance rule. Competing candidates are resolved largest first. The one-line declaration pass runs before the token pass, and the copy pass after it, each only on unclaimed lines.

**Budget.** One work budget covers a whole change, counted in work units instead of time so the same input always gives the same output: characters of short seeds compared, candidates created and alignment cells filled. The limits are 200,000 units in the `tokens` pool (short seeds spend their non-space characters, and the token pass spends one unit per token it produces, or one per line in YAML), 5,000 candidates (short seeds and one-line declaration pairs), 16,000,000 alignment cells in total (the existing per-alignment cap becomes this shared pool) and 50,000 candidate extensions, charged before each candidate is extended so that discovery stops once the budget is spent. The token pass spends the `tokens` pool, one unit per token, as it tokenizes unclaimed runs. The checker does not draw from the pool, and stays linear by scanning the patches once per batch of claims. When the budget runs out, the matcher stops and returns the operations it has already found. Exhaustion truncates silently, and `droppedClaims` only counts claims the checker rejected. The 2,000 ms post-hoc cap in `review.ts` stays as a backstop.

**Residual risk.** A hunk that starts inside a multi-line literal whose opening and closing delimiters are both outside the visible hunk cannot be detected, because nothing in the patch text shows the literal. The literal-file skip catches every file where a delimiter is visible. Rust and C# multi-line string openers outside the hunk are in the same class. The cost is a wrong exact match on lines that are literal content, and the guards above make it a narrow case. The body of a multi-line comment or string whose opener and closer both lie outside the hunk is read as code. That residual risk is inherited from the line matcher and accepted.

### PR C: function-to-method and copies

**Reshape normalization.** Two blocks that open with a definition are compared as signature plus body.

- Discovery is from body tokens (PR B). The signature is then found by walking up from the matched body on both sides: the opening logical line (bracket depth decides where it ends, so a four-line parameter list is one signature) and any decorators directly above it (`@name` lines). The two signatures are paired however different the name, parameters and types are. Each physical line of either signature becomes one divergence of the new class `signature`, with its original text. The checker derives these boundaries from the patch text itself, not from the matcher's segmentation.
- The reshape scope is `py`, `pyi`, `js`, `jsx`, `mjs`, `cjs`, `ts` and `tsx`. A `self.` or `cls.` prefix (Python) or a `this.` prefix (JavaScript and TypeScript) may be removed from one side to nominate a match. It never hides a change. Every body line that matched only because of the prefix rule becomes a divergence with the original text. A call that gained `this.` can resolve to different code, so the reviewer sees each such line. A line is class `receiver` when the prefix changed on the read side of the line. It is class `code` when the prefix was added, removed or changed on an assignment target (the left side of `=` or of an augmented assignment such as `+=`), or when one receiver was dropped and another added on the same line, because those edits change which state the line reads or writes. `receiver` lines are excluded from the divergence limit. The review weight is the number of `signature` and `code` divergences, plus the renamed identifiers, plus 1 when any `receiver` divergence is present (a flat 1, however many receiver lines there are).
- The opener scan ignores lines over 2000 characters and treats `with` as control flow, so `with (scope) {` is never a definition.
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
  - A claim whose spans share a file must not have both sides in one change region (one stretch of changed lines between context lines or hunk headers), and the squeezed text of each side must occur at most once among the changed runs of all patches.
  - A claim under 5 counted lines fails on a line over 2000 characters, on two same-file sides in one hunk, on a side that begins with a closing bracket or leading operator, on a side that is an unclosed single line or whose span does not balance its brackets, and when the statement may continue past a side by the matcher's tests, read from the next line of the patch.
  - It then needs 30 non-space characters of information (50 within one file), a whole definition of 40, or a one-line top-level declaration whose head side passes the same name, family and value tests (`FOO == bar` is not a declaration). Each side must occur at most once among the changed runs.
- B: the token streams it builds itself are equal, using the same newline class and only the listed normalizations.
- C: a copy's `from` span exists in the head, as an added or context line, a signature divergence covers every physical line of the signature it derives from the patch, and every body line that matches only after receiver removal appears as a `receiver` divergence, or as a `code` divergence when the prefix change touches an assignment target or swaps one receiver for another, and the weight equals the signature and code count plus the renamed count plus 1 for any receiver.

### Rendering

Relocations in the same file read "moved within `file`". `shape.reindent` adds ", re-indented one level deeper" or ", re-indented 2 levels shallower" to the relocation line for Python (`py`, `pyi`, 4 columns per level), and ", re-indented 2 columns deeper" for YAML and for any shift that is not a multiple of 4. `signature` and `receiver` divergences are listed with the code divergences, each with its original text. A copy reads "copied from <span> (source visible in this diff only)". None of this text says the code is safe or unchanged in behavior. The 12 detailed operations and 6000 character limits stay. Operations rank by type, then claims with a code difference before those without, then lines covered. A one-line move with a code difference is therefore never summarized behind larger exact moves, and exact one-line moves fall below larger ones and are the first to be summarized in the count line. Copies rank below relocations.

## Verification

- Unit tests per matcher change, named by behavior.
- Seeds. New seed families score detection: a same-file reorder, a one-line move, a 2-line definition move, a reformatted move (REL-13/original), a Python re-indented move (REL-14/original), a YAML re-indented move (REL-14/v1) and a Python move with one line dedented out of step (REL-14/v2, which must yield no operation), a function converted to a method, a duplicated block. The seed count in `detect.test.ts` and every `truth.json` update with them.
- A negative seed per risk: an in-place edit that must not become a same-file move, a repeated line that must not match, a template-literal reformat that must stay unmatched (REL-13/v1).
- The false-positive measurement over the last 150 commits (`findRelocations` on their git diffs), run before each PR merges. Every operation the new rules add that is not a true move or copy is logged with the commit. The bar is zero such operations at the chosen thresholds. If one appears, the threshold moves toward a miss and the measurement runs again.
- Gates: tests, typecheck, lint, `config:check`, `replay --seeds --check`.
- After PR C, the `a-dm` against `a` replay comparison is still not part of this work.

## Calls made without asking Joe

- Copies are patch-only, as Joe ruled. Context-line sources are included because they cost almost nothing and are labeled as partial.
- Same-file pairs are excluded within one change region. Alternative: allow them and filter by distance. Rejected because every in-place edit would qualify.
- The 1 to 4 line rule requires uniqueness across the whole patch, and the thresholds (30 characters for short seeds, 40 for a one-line definition) are starting values to tune on the measurement.
- Quote-style swaps are limited to JS, TS and Python. Ruby and shell use quotes to switch interpolation.
- Unknown file extensions are treated as line-significant, the stricter class, and the token pass skips them.
- Copies get a higher floor than relocations.
- Short same-file seeds need different hunks and 50 characters of information, and short seeds that continue an expression are rejected, all toward a miss, on the evidence of three false positives in the PR A measurement: `229b796f` (`expect(r.fileNotes.size).toBe(0);`, 31 characters), `32a55e79` (`return { ready: missing.length === 0, missing };`, 41) and `996b67e0` (`.split("\n")` and `.find((l) => l.trim())`, 32).
- Lockfiles and generated files are excluded from relocation matching in `findRelocations` only. `findMovedBlocks()` is unchanged.
- The `signature` and `receiver` divergence classes are new, so a changed signature or a changed call receiver is not buried among comment-only and rename classes.
- The work ships as three PRs, ordered by risk and dependency.
- Review of PR B changed three rules, all toward a miss. The token pass eligibility moved from a broad file-type list to the allowlist above, with YAML in line mode and same-extension-family pairing, after reviewers found false exact matches in CSS and Scala. Files with a visible backtick, triple quote or heredoc opener are skipped and candidate ranges need balanced brackets,. Quote swaps are off in JSX and TSX, after a swap inside JSX text was accepted as exact. Over the last 150 non-merge commits PR B added one operation to PR A's 89, with no false positives, and the checker dropped none.

## Left to the builder

- The exact token regex additions for decorators.
- How the change region id is stored on `Run`.
- Tuning the information and uniqueness thresholds against the measurement.
- Names and numbering of the new seed families.
- The wording of the new render lines.

## Follow-ups this enables

- Detecting in-place reformats as `mechanical` operations with the PR B token normalization.
- Reading base file contents to find copies of unchanged code, if the cost is ever accepted.
