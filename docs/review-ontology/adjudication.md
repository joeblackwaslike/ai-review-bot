# Adjudication

Adjudication gives a verdict to review candidates that the deterministic join could not match to a labelled claim. Without it, an unmatched candidate could be a false positive or a real defect nobody labelled, and precision cannot be computed. The code is in `src/replay/adjudication/`, and `ai-review replay --adjudicate` runs it.

## What gets judged

The candidates are the distinct candidates in a fixture's saved traces that `joinsClaim` leaves unmatched. Two candidates count as the same claim when they have the same file, the same set of title words and the same set of code identifiers named in the title, so rewording and line moves do not cause a second call but two titles that differ only in a backticked name stay apart. A title with no words and no identifiers is compared by its normalized text. A claim is judged once even if several strategies or rounds produced it, and the judge sees the diff of the first round that produced it.

Each judge sees the finding's title, location and text, plus the diff of the file it points at. It does not see which strategy, provider or model produced the finding. It answers `real`, `not-real` or `unclear`. For a `real` verdict it also gives a scope: `change` when the problem comes from code the pull request adds or edits, `moved` when the code was only moved, renamed or reformatted and the problem was already there.

## Which models judge

An Anthropic-produced candidate is judged first by a different Anthropic model than the one that produced it. The first judge is Opus; if the producer was Opus, the first judge is Sonnet. The producer's model comes from routing the round's compare files the same way the live tier does. When a round's compare files cannot be fetched, the candidates from that round are not judged: they are counted as deferred and listed with the reason "evidence unavailable", and nothing is cached for them.

A first verdict of `real` or `unclear` is cross-checked by an OpenAI model. When both agree, the verdict stands. When they disagree, the verdict is `unresolved`. It is counted and reported, left out of precision and recall, and never sent to a human.

An OpenAI-produced candidate is judged by Anthropic models only and gets no OpenAI check.

A verdict with no cross-check is marked `single-family`. The command prints "single-family verdicts have no second-model check" whenever there is at least one.

## Quota caps

`--max-anthropic` defaults to 40 and `--max-openai` defaults to 0. The runner refuses to start a call that would pass either cap. A candidate that cannot be judged under the Anthropic cap is counted as deferred and left without a verdict. With the OpenAI cap at 0 the command does not authenticate to OpenAI at all, and every verdict that could have been cross-checked is `single-family`.

A later run with a higher OpenAI cap upgrades those cached `single-family` verdicts: it runs only the second judge, and overwrites the cached record with `agreed` or `unresolved`. Verdicts that were `not-real` are never cross-checked.

Judge spend is its own line in the output, counted in calls, and is not part of any strategy's cost.

## Cache

Verdicts are stored per fixture snapshot as JSON lines in `~/.ai-review/adjudication/<snapshot>.jsonl`. `AI_REVIEW_ADJUDICATION_DIR` overrides the directory. The snapshot id is a hash of the fixture with its traces removed, so saving a trace does not invalidate the cache but a change to the recorded claims does. The labels file is not part of the snapshot; audit records are keyed by a hash of the labels file as well, so changing a label re-runs the audit. The last record for a key wins, and unreadable lines are skipped and counted. A cached verdict is ignored, and judged again, when its first judge's prompt hash or model differs from the current ones. A judge error, from either judge, is counted under `errors` only: it produces no verdict, is not tallied and is not cached, so the next run tries again. Writes append one line per verdict, so two runs on one snapshot do not overwrite each other.

## Planning a run

`--plan` prints how many candidates are cached, how many would be judged, how many calls each cap allows, how many would be deferred, and how many cached verdicts could be upgraded. It builds no judge and calls no model. Run it before a real run.

## Fixture audit

`--audit` asks a judge to read the fixture's diff with the labelled claims shown and list real defects none of them covers. A listed defect that `joinsClaim` matches to a label is dropped. The rest go to the second judge when the OpenAI cap allows it. A defect the second judge also lists is stored as an audit record; one it does not list is counted as unresolved. Without a second judge the defects are stored marked `single-family`. Audit records carry the kind `audit`, so they cannot be read as candidate verdicts, and a finished audit is remembered, under the snapshot and the labels hash, so a repeat run makes no call unless the audit prompt, the judge model or the labels changed. The audit reads the last round's diff only. If that diff cannot be fetched the audit stops with a message and records nothing. The added defects join the recall denominator, marked `auditAdded`. Scoring itself belongs to a later phase.
