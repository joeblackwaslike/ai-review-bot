# Per-repo override file

A repository can narrow how it is reviewed by committing `.github/ai-review.yml`. The file can only make the review stricter or quieter. The deployment config, env and Edge Config set the ceiling, and the file cannot raise it.

## Where it is read from

The bot reads the file from the repo's default branch, never from the PR head. A PR author cannot change how their own PR is reviewed. A change to the file takes effect once it merges, and the bot caches the result for up to 10 minutes per default-branch commit.

The file must be a regular file of 20 KB or less, valid UTF-8 and valid YAML.

## What a repo can set

| Key | Effect |
| --- | --- |
| `reviewers.<id>.enabled: false` | Turn one reviewer off in this repo. |
| `reviewers.<id>.runOn` | Run that reviewer only on these tiers. |
| `reviewers.<id>.skills.<name>.enabled: false` | Turn one skill off for that reviewer. |
| `routing.sensitivePathPatterns` | Extra path fragments that count as sensitive when the PR is classified. A path matches if it contains the fragment, ignoring case. Up to 50 fragments, each up to 100 characters. |
| `review.minSeverity` | Drop findings below `P2` or `P1`. `P3` is the default. P0 and P1 are never dropped by the floor. |
| `review.customPrompt` | Extra review instructions (up to 2000 characters). |
| `review.command` | The slash command that starts a review in this repo. It starts with `/` and is at most 50 characters. |

## What a repo cannot do

- Enable a reviewer or skill that the deployment disabled. Only `enabled: false` is accepted.
- Add a model, change a model's tier or effort, or change a GitHub App.
- Exceed the deployment's budgets.
- Lower anything: `minSeverity` cannot go below the deployment value, and `runOn` cannot add a tier the deployment excludes.

## How layers combine

- A reviewer or skill runs only if every layer leaves it enabled: deployment YAML, env, Edge Config and the repo file (logical AND). A repo disable cannot be undone by an env `enabled=true`.
- `runOn` is the intersection of the layers.
- For `review.customPrompt` and `review.command`, env beats the repo file and the repo file beats YAML.
- A repo `review.command` replaces the deployment command in that repo. The deployment command does not start a review there.

## An invalid file

An invalid file is ignored as a whole. The review still posts, and its body carries a one-line note that names the problem, for example `.github/ai-review.yml is invalid at review.minSeverity (invalid_value)`. The note names the field and the error code, never the value. A missing file is not an error and adds no note.

## Example

```yaml
# .github/ai-review.yml
version: 1

reviewers:
  codex:
    runOn: [complex]
  claude:
    skills:
      comment-analyzer:
        enabled: false

routing:
  sensitivePathPatterns:
    - billing/
    - .sql

review:
  minSeverity: P2
  customPrompt: |
    This repo targets Node 22 only. Do not suggest compatibility shims for older runtimes.
  command: /review-this
```
