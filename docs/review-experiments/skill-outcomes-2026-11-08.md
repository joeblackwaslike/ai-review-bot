# Skill outcomes after B2

Bead `ai-review-bot-t0c.14` (C3). A snapshot taken on 2026-11-08 with `ai-review skill-outcomes`, covering the 264 findings the bots posted from 2026-11-02 onward (after B2 landed) across 44 PRs in every repo the corpus tracks. No ledger failed to load.

## How it is counted

The corpus (`finding_catalog`) says which skills raised each finding. The outcome comes from the live PR ledger, read the way adaptive limits read it (`classifyFinding`), including thumbs-up and thumbs-down reactions on the comment. The corpus's own feedback classification is not used: it runs weekly and had classified nothing posted after B2 when this was taken.

A finding that several skills raised counts under each of them, so the column totals exceed 264.

- **Fixed**: the author fixed or resolved it, or reacted with a thumbs-up.
- **Rejected**: the author rejected it, or reacted with a thumbs-down.
- **Deferred**: the author deferred it.
- **Unanswered**: still open with no reply or reaction.
- **Restated**: posted after an earlier finding by the same reviewer on the same PR that states the same claim (`isSameClaim`).
- **Unmatched**: no ledger entry could be tied to the finding, so it has no outcome. This is about a third of all rows.
- **Rejected share**: rejected over fixed, rejected and deferred.

| Skill | Posted | Fixed | Rejected | Deferred | Unanswered | Restated | Unmatched | Rejected share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| silent-failure-hunter.md | 63 | 36 | 2 | 0 | 8 | 1 | 17 | 5% |
| comment-analyzer.md | 56 | 31 | 0 | 1 | 5 | 0 | 19 | 0% |
| code-review-and-quality.md | 47 | 21 | 2 | 1 | 5 | 0 | 18 | 8% |
| security-sast.md | 43 | 23 | 0 | 0 | 7 | 0 | 13 | 0% |
| pr-test-analyzer.md | 36 | 15 | 0 | 0 | 7 | 0 | 14 | 0% |
| security-auditor.md | 29 | 14 | 1 | 1 | 2 | 0 | 11 | 6% |
| code-reviewer.md | 27 | 11 | 1 | 0 | 5 | 0 | 10 | 8% |
| architect-review.md | 24 | 12 | 2 | 0 | 3 | 0 | 7 | 14% |
| type-design-analyzer.md | 17 | 11 | 1 | 1 | 3 | 0 | 1 | 8% |

## What it shows

- Rejections are 9 of 187 answered skill-findings, and no skill has more than 2. At that sample size nothing separates the skills. The highest share, architect-review at 14%, rests on 2 rejections.
- "Fixed" measures acceptance by the author, not value. Most of these PRs are driven by agents that fix nearly everything they are told, so a high fixed count does not show a skill found real defects.
- Restated is 1 of 264. Findings that restate an open or settled one are now mostly suppressed before posting, and the suppressed ones are not in the corpus (`finding_discards` was empty when this was taken), so this table undercounts what the skills raise.
- About a third of the rows are unmatched. The likely causes are comments on reviews whose heading does not match the configured prefix and merged comments whose claims cannot be told apart. I did not break it down further.

## What this does not answer

Leave-one-lens-out, the second half of C3, is not done: it needs `replay --live` with a strategy that drops one skill, and it costs money. F1 (`ai-review-bot-t0c.26`) should not decide on this table alone.

## Re-running it

```bash
export DATABASE_URL=...   # the Neon corpus
export GITHUB_TOKEN=...   # read access to the PRs
ai-review skill-outcomes [--since 2026-11-02] [--repo owner/name] [--json]
```
