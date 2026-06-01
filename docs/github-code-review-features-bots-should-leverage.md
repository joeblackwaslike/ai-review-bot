# Key GitHub PR Review Bot Features Worth Leveraging

## Batched/Pending Reviews

Create a review, attach all inline comments, then submit once. This fires a single notification instead of one per comment and keeps the review atomic. Use `POST /repos/…/pulls/…/reviews` with `event: REQUEST_CHANGES` or `APPROVE`.

## Multi-line Suggestion Blocks

Suggestions can span multiple lines. Combine with the `start_line` / `line` parameters when creating review comments. Critical for refactor suggestions.

## Review Thread Resolution

Bots can programmatically resolve/unresolve comment threads via GraphQL (`resolveReviewThread`). Useful for auto-resolving threads when a follow-up commit fixes the flagged issue.

## Review State Transitions

`REQUEST_CHANGES` blocks merge (if branch protection requires it). A bot can APPROVE or dismiss its own previous reviews when conditions change — giving you a real merge gate, not just informational comments.

## PR Description Mutation

Bots can rewrite the PR body with structured summaries, checklists, or risk assessments on each push. Pairs well with a summary section the bot owns (delimit it with HTML comments so you can find/replace it).

## File-level Comments

Comments without a `line` reference attach to the file card rather than a specific line. Useful for "this entire file needs X treatment" observations.

## Draft PR Detection

Check `draft: true` and skip expensive reviews; re-trigger on the `ready_for_review` event. Saves API quota and avoids noise.

## Highest-Leverage Combination

**Batched review + suggestion blocks + check run annotations** — reviews own the conversational feedback, annotations own the machine-generated lint/security findings.
