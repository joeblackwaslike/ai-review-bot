# Verifier spike (S3)

Bead `ai-review-bot-t0c.15`. Run on 2026-11-08 with `ai-review verifier-spike`. This is the offline test the D1 verifier waits on: does a model from the other vendor, given a finding and the current file, refute the findings the author rejected without refuting the ones the author fixed?

## What was run

- **Findings**: the fixed and rejected labelled claims in the replay fixtures that have a file path. 153 findings. Left out: 119 deferred or unadjudicated labels and 36 claims with no file path.
- **Judges**: always the other vendor. Anthropic findings go to OpenAI (`gpt-6-luna` cheap, `gpt-6.1-sol` mid) and OpenAI findings go to Anthropic (`claude-haiku-5-5` cheap, `claude-sonnet-5-5` mid).
- **Input**: the finding text and the whole file at the head sha of the round that posted it, with line numbers. No ledger.
- **Output**: `{refuted, reason, rationale}`, verdict first, as in the spec. The spec's fifth reason (contradicts a settled ledger entry) is left out because there is no ledger input.
- **Prompt**: refute only with counter-evidence you can point to in the file. See `src/replay/verifier-spike/prompt.ts`.
- **Cost**: two full runs of 306 calls each, $1.48 apiece, plus a $0.04 smoke run. The tables below are the first run.

## Results

Counts use confirmed labels only. A finding is "dropped" when the judge refuted it.

| Producer | Judge | Tier | Rejected dropped | Fixed P0/P1 dropped | Fixed P2/P3 dropped | Unverified | Cost | Meets criteria |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| anthropic | gpt-6-luna | cheap | 18/37 (49%) | 0/0 | 3/8 (38%) | 4 | $0.04 | no |
| anthropic | gpt-6.1-sol | mid | 16/37 (43%) | 0/0 | 1/8 (12%) | 4 | $0.71 | no |
| openai | claude-haiku-5-5 | cheap | 2/7 (29%) | 1/6 (17%) | 4/35 (11%) | 6 | $0.04 | no |
| openai | claude-sonnet-5-5 | mid | 1/7 (14%) | 0/6 (0%) | 0/35 (0%) | 6 | $0.72 | no |

The same cells for provisional labels (auto-labelled, not yet checked):

| Producer | Judge | Rejected dropped | Fixed dropped |
| --- | --- | ---: | ---: |
| anthropic | gpt-6-luna | 5/10 (50%) | 12/23 (52%) |
| anthropic | gpt-6.1-sol | 8/10 (80%) | 14/23 (61%) |
| openai | claude-haiku-5-5 | 0/0 | 5/17 (29%) |
| openai | claude-sonnet-5-5 | 0/0 | 2/17 (12%) |

Four findings could not be judged because their file does not exist at their head sha (`src/replay/retraction-rule.ts`). They are counted as unverified and drop nothing.

The D1 criteria are to drop at least 40% of rejected findings, no fixed P0 or P1, and at most 5% of fixed P2 and P3.

## What it shows

1. **No cell meets the criteria.** Each fails on one measure, and several rest on very few findings.
2. **The samples are small.** OpenAI-authored findings have 7 confirmed-rejected and Anthropic-authored findings have no fixed P0 or P1. Every fixed P2 and P3 rate for Anthropic-authored findings rests on 8 findings, where one drop is 12.5%. Read these as direction, not as a pass or fail.
3. **The cheap tier is not safe.** `claude-haiku-5-5` refuted a fixed P1 (a caller-controlled profile that bypasses pacing) and 4 of 35 fixed P2 and P3. It also contradicts itself: it marked a finding refuted while its rationale said the finding "is accurate". `gpt-6-luna` refuted 3 of 8 fixed P2 and P3.
4. **The mid tier is the better choice.** `claude-sonnet-5-5` refuted none of the 41 confirmed-fixed findings but also only 1 of 7 rejected. `gpt-6.1-sol` refuted 16 of 37 rejected (43%) and 1 of 8 fixed P2 and P3.
5. **"Fixed" is a weak ground truth for small findings.** The seven provisional fixed findings that `gpt-6.1-sol` refuted and I read were all P3 comments, test wording and style notes, refuted with specific line citations. Agent-driven authors fix nearly everything they are shown, including nits, so a fixed label means the author acted, not that the finding was right. The 5% ceiling on fixed P2 and P3 is probably too strict as written. Checking those refutations with the adjudication pipeline would settle it.

## How stable it is

A second full run, on a fresh cache and the final code, gave the same refuted flag for 266 of 286 verdicts (93%). No cell changed its pass or fail. Headline counts moved by at most 2 findings, except `gpt-6-luna` on fixed P2 and P3, which went from 3 of 8 to 1 of 8. That swing is what 8 findings can do, and it is why point 2 above says to read the small cells as direction only.

## Recommendation

- Use the **mid tier** for both vendors: `gpt-6.1-sol` for Anthropic findings and `claude-sonnet-5-5` for OpenAI findings. A mid call costs about $0.009 to $0.010, so a review with ten findings adds about $0.10.
- Do not ship D1 on this evidence. Before it, get more labelled data (fixed P0 and P1 for Anthropic findings, rejected findings for OpenAI findings), adjudicate the mid-tier refutations of fixed findings, and make the verifier treat a rationale that concedes the finding as not refuted.

## What this does not cover

Findings with no file path (36), cross-file claims that need other files, a ledger input, more than one sample per call, and any prompt other than the one in `prompt.ts`.

## Re-running it

```bash
export GITHUB_TOKEN=...   # read access to the repos in the fixtures
ai-review verifier-spike --plan               # counts and a cost estimate, no calls
ai-review verifier-spike [--tier cheap|mid] [--max-cost 10] [--json]
```

Verdicts are cached in `~/.ai-review/verifier-spike/` (`AI_REVIEW_VERIFIER_SPIKE_DIR` overrides), keyed by prompt, model, effort and the finding's text and location, so a rerun costs nothing and a changed prompt or finding starts fresh. A run that stops at the cost cap exits 3; calls already in flight can push the spend a little past the cap. The command refuses to run when a judge model has no price, because the cap could not hold.
