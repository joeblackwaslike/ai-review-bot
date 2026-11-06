# Join-rate investigation: ai-listings#50

## Question

The join rate counts how many distinct review candidates restate a labelled claim. Candidates are deduplicated by path, line and title within each round, and the per-round counts are then summed, so a candidate raised again in a later round counts again. On the held-out ai-listings#50 fixture the anthropic trace joined 0 of 15 candidates and the openai trace 0 of 5. Either the reviewer found nothing the labelled threads cover, or the matcher misses real restatements.

## Method

`ai-review replay --investigate-join <fixture-id>` (`src/replay/join-investigation.ts`) takes each distinct trace candidate and its nearest labelled claims (same path first, nearest line first, up to 3 per candidate). A judge from the other model family than the fixture's provider is shown the candidate, the claim's full text and the candidate's file diff, and says whether the two state the same problem. The run is capped at 20 judge calls. The matcher's own verdict (`isSameClaim` at `JOIN_CLAIM_MATCH`) is printed beside the judge's.

Anthropic fixture: the judge was `gpt-6.1-sol` (OpenAI). 15 pairs were judged, one per candidate. The matcher joined none of them.

## Result

The judge called 3 of the 15 pairs the same problem and 12 different. The other 12 candidates were each judged against their nearest labelled claim and judged different from it, so none of them has a counterpart among the labelled claims.

All 3 matches are candidates at line 502 against one claim at line 496 of `src/lib/pipeline/step3-pricing-research.ts`:

- "Prose with valid-JSON braces can shadow the real payload"
- "Valid-JSON prose object stops the scan before the real payload"
- "Valid-JSON prose braces can mask the real payload"

The claim's title is "Log condition misses the case where the first parsed object has zero entries due to all entries being invalid". Its body argues something else: the loop breaks after the first candidate that parses as valid JSON, so a prose `{}` hides the real payload later in the text. The candidates restate the body. The title misstates it, so the title-similarity matcher scored them at 0, and they sit 6 lines from the claim, outside the 3-line window of `JOIN_CLAIM_MATCH`.

Several of the 12 different pairs share both path and line with a claim (for example "Empty-object case no longer logged" and "Silent empty result may hide malformed LLM output", both at line 492 against a claim at 492). A wider line window or a lower title bar alone would join them, so the fix has to use more than distance.

## Chosen matcher

`JOIN_BODY_MATCH` in `src/replay/metrics.ts`, applied by `countJoined` in addition to the existing rule. A candidate joins a claim when all of these hold:

1. Same path, both anchored, at most 10 lines apart.
2. At least 5 of the candidate title's content words (`claimTokens`) appear in the claim's title and body.
3. Those shared words are at least 75% of the candidate title's content words.

How it was chosen: the claim's body, not its title, carries the argument, so the candidate title is measured against the full claim text. For the 15 pairs, coverage was 0.78 to 0.86 for the 3 matches and up to 0.80 for the worst different pair ("Empty-object case no longer logged": 4 of 5 words, because its few words are common in the claim). Coverage alone cannot separate them. The matches share 6 or 7 words and that pair shares 4, so a minimum count of shared words is added. The line window of 10 is not exercised by the data beyond the 6-line gap; it is a round number above that gap.

The table test `src/replay/join-body-match.test.ts` encodes the 3 positives and 12 negatives and was written first: 3 failed, 12 passed before the change, 15 passed after.

## Effect on other fixtures

Re-running `computeMetrics` over every fixture with a trace: only ai-listings#50 anthropic changed (0/15 to 3/15). The other eight traced fixtures kept their figures, so the rule adds no new joins there. ai-review-bot-demo#2 openai stays at 2/4.

## Limits

- One judge, one family. There is no second-family check on the 3 matches or the 12 differences.
- The openai half did not run. The 5 openai candidates were to be judged by an Anthropic model, but the Claude session expired. The 0 of 5 openai figure is still unexplained.
- Both thresholds (5 shared words, 0.75 coverage) come from 3 positives on one fixture from one repository. They are provisional until validated on a second fixture from a different repository.
- The figure is still a lower bound: candidates whose claim is on a different file (a test-gap candidate on the source line against a claim in the test file) do not join.
