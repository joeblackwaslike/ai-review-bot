# CLI & npm Package

In addition to the webhook-based GitHub App, `ai-review-bot` ships as an npm package with a CLI tool for running full-repository audits on demand — no PR, no webhook, no Vercel required.

## Local review (`ai-review review`)

Run the full multi-agent review against your **local** working copy and write a durable Markdown report into `docs/code-reviews/` — no GitHub PR, and it can bill your existing Codex / Claude subscription instead of API credits.

```bash
ai-review review [--full | --commit <sha>] [--slug <slug>] [--title <t>] [--out <dir>] [--extra <text>] [--json]
```

| Flag | Description |
| --- | --- |
| _(default)_ | Review **local changes** (committed + working-tree, vs the merge-base with the default branch). |
| `--full` | Review the **entire tracked tree**. |
| `--commit <sha>` | Review exactly the files touched by `<sha>`, read at that commit. |
| `--slug <slug>` | Override the filename slug (default: branch / commit subject / `full-audit`). |
| `--title <t>` | Override the report H1 / front-matter title. |
| `--out <dir>` | Output directory (default `docs/code-reviews`). |
| `--extra <text>` | Extra instructions passed to every review agent. |
| `--json` | Print `{ path, durationSeconds, costUsd, filesReviewed, providers }` to stdout. |

Reports are named `<YYYY-MM-DD>-<slug>-<NN>.md` with a per-day, per-slug round number, and carry YAML front-matter (`status`, `scope`, `remote`, `duration_seconds`, `cost_usd`, `providers`, `models`, `skills`, `findings`). Flip `status: reviewed → implemented` once findings are addressed.

### Auth resolution (local, personal use only)

Per provider, the CLI tries in order: **API key** (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, or an explicit `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) → **subscription OAuth** from your logged-in `codex` (`~/.codex/auth.json`) and Claude Code (macOS Keychain). A provider that can't authenticate is skipped.

> ⚠️ The OAuth fallback is for your own machine only. Anthropic's ToS (eff. 2026-02-20) prohibits using Claude *subscription* OAuth tokens in third-party tools outside Claude Code / Claude.ai, and refresh tokens are shared with the real CLIs. See [docs/code-reviews/README.md](./code-reviews/README.md). The hosted webhook bot is unaffected — it uses API keys only.

### Fix workflow

The `/code-review` slash command (in `.claude/commands/`) wraps this CLI with three modes: **doc-only** (default), **`--fix`** (auto-apply findings + run gates + flip status), and **`--propose`** (propose fixes, get sign-off, then apply).

## What the audit does

The audit mode fetches every code file in a repository at a given ref, batches them into 150 KB chunks, and runs all five review agents on each batch. Findings are merged, deduplicated, and posted as a GitHub issue in the target repo. It runs against the entire codebase, not just a diff.

Supported file extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`, `.rb`, `.java`, `.cs`, `.cpp`, `.c`, `.h`, `.swift`, `.kt`.

## Installation

```bash
npm install -g ai-review-bot        # global install
npx ai-review-bot@latest owner/repo # one-off, no install
```

## Usage

```bash
ai-review OWNER/REPO [--ref <branch-or-sha>] [--dry-run] [--extra <instructions>] [--provider <anthropic|openai>]
```

### Arguments

| Argument | Description |
| --- | --- |
| `OWNER/REPO` | Repository to audit (required) |
| `--ref <ref>` | Branch, tag, or SHA to audit. Defaults to the repo's default branch. |
| `--dry-run` | Print the audit report to stdout instead of creating a GitHub issue. |
| `--extra <text>` | Additional instructions passed to every review agent. |
| `--provider <name>` | AI provider: `anthropic` (default) or `openai`. |

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_APP_ID` | ✓ | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | ✓ | PKCS#8 private key PEM (`\n` for newlines) |
| `ANTHROPIC_API_KEY` | ✓ (anthropic) | Anthropic API key (required when using `--provider anthropic`) |
| `OPENAI_API_KEY` | ✓ (openai) | OpenAI API key (required when using `--provider openai`) |

### Examples

```bash
# Audit the default branch, post findings as a GitHub issue
GITHUB_APP_ID=12345 \
GITHUB_APP_PRIVATE_KEY="$(cat key.pem | awk 'NF {printf "%s\\n", $0}')" \
ANTHROPIC_API_KEY=sk-ant-... \
ai-review joeblackwaslike/my-project

# Audit a specific branch without posting (dry run)
ai-review joeblackwaslike/my-project --ref feature/new-api --dry-run

# Audit with extra instructions
ai-review joeblackwaslike/my-project --extra "focus on database query safety"
```

### Output

On success the CLI prints progress as it runs:

```
Found 142 code files in joeblackwaslike/my-project@main
Fetched 142 files
Running agents over 3 batch(es)...
  Batch 1/3: 20 files
  Batch 2/3: 20 files
  Batch 3/3: 20 files
Audit issue created: https://github.com/joeblackwaslike/my-project/issues/47
```

With `--dry-run`, the report is printed to stdout instead of posted as an issue.

## GitHub Action

Use the published action to run a full-repo audit inside any CI workflow:

::: v-pre

```yaml
- uses: joeblackwaslike/ai-review-bot@v0.1.0
  with:
    github-app-id: ${{ secrets.GITHUB_APP_ID }}
    github-app-private-key: ${{ secrets.GITHUB_APP_PRIVATE_KEY }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

:::

### Action inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-app-id` | ✓ | — | GitHub App ID |
| `github-app-private-key` | ✓ | — | PKCS#8 private key PEM (newlines as `\n`) |
| `anthropic-api-key` | — | — | Anthropic API key (required when provider is `anthropic`) |
| `openai-api-key` | — | — | OpenAI API key (required when provider is `openai`) |
| `provider` | — | `anthropic` | AI provider: `anthropic` or `openai` |
| `repo` | — | current repository | Repository to audit (`owner/repo`) |
| `ref` | — | repo default branch | Branch, tag, or SHA to audit |
| `dry-run` | — | `false` | Set to `true` to print the report without creating an issue |
| `extra` | — | — | Additional instructions for the review agents |
| `version` | — | `latest` | npm version of `ai-review-bot` to use (e.g. `0.1.0`) |

### Scheduled audit example

Run a full codebase audit every Monday morning and post findings as a GitHub issue:

::: v-pre

```yaml
name: Weekly audit

on:
  schedule:
    - cron: '0 8 * * 1'   # every Monday at 08:00 UTC
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: joeblackwaslike/ai-review-bot@v0.1.0
        with:
          github-app-id: ${{ secrets.GITHUB_APP_ID }}
          github-app-private-key: ${{ secrets.GITHUB_APP_PRIVATE_KEY }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

:::

### Audit a different repo

::: v-pre

```yaml
- uses: joeblackwaslike/ai-review-bot@v0.1.0
  with:
    github-app-id: ${{ secrets.GITHUB_APP_ID }}
    github-app-private-key: ${{ secrets.GITHUB_APP_PRIVATE_KEY }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    repo: myorg/other-repo
    ref: main
    extra: "This codebase uses strict null checks. Flag any unsafe casts."
```

:::

## Difference from PR reviews

| | PR Review (webhook bot) | Full Audit (CLI / Action) |
| --- | --- | --- |
| **Trigger** | PR opened, pushed, or `/ai-review` command | Manual, scheduled, or CI step |
| **Input** | Unified diff of changed lines | All code files in the repo |
| **Output** | GitHub Pull Request Review with inline comments | GitHub Issue with a structured report |
| **Providers** | Claude + Codex in parallel | Claude (default) or Codex (`--provider openai`) |
| **Inline comments** | Yes — anchored to diff lines | No — whole-file findings only |

## Private key formatting

Both the CLI and the Action require the private key as a single-line string with `\n` for newlines:

```bash
awk 'NF {printf "%s\\n", $0}' your-private-key.pem
```

Store the output as a GitHub Actions secret or shell environment variable. The CLI normalizes `\n` back to real newlines at runtime.

<!-- qstash smoke test 9942161 -->
