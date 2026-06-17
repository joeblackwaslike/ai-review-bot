# Code Reviews

Durable Markdown reports produced by `ai-review review` (and the `/code-review` slash
command). Each report is a point-in-time review of local changes, the full tree, or a
specific commit.

## Filenames

```
<YYYY-MM-DD>-<slug>-<NN>.md
```

`NN` is a zero-padded round number that increments per day + slug, so re-reviewing the
same change yields `…-01.md`, `…-02.md`, … — a natural review → fix → re-review trail.

## Front-matter

Every report starts with YAML front-matter for tracking:

| Field | Meaning |
| --- | --- |
| `status` | `reviewed` when written; flip to `implemented` once findings are addressed |
| `scope` | `local-changes` \| `full-tree` \| `commit:<sha>` |
| `remote` | GitHub URL of the repo |
| `timestamp` | ISO 8601 when the review ran |
| `duration_seconds`, `cost_usd` | how long it took / token cost |
| `providers`, `models`, `skills` | which providers, models, and review agents ran |
| `files_reviewed`, `findings` | counts |

Below the front-matter is a table of contents, a summary, findings, inline notes, and a
metadata section.

## Authentication (local, personal use only)

`ai-review review` resolves auth per provider:

1. **API key** — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (also `ANTHROPIC_AUTH_TOKEN` /
   `CLAUDE_CODE_OAUTH_TOKEN` for an explicit Bearer token).
2. **Subscription OAuth fallback** — your logged-in `codex` (`~/.codex/auth.json`) and
   Claude Code (macOS Keychain) sessions.

> [!WARNING]
> The subscription OAuth path is for **your own machine only**.
>
> - Anthropic's ToS (eff. 2026-02-20) prohibits using Claude *subscription* OAuth tokens
>   in third-party tools outside Claude Code / Claude.ai. The hosted webhook bot uses API
>   keys only and never touches this path.
> - Refresh tokens are single-use and shared with the real `codex` / `claude` CLIs. The
>   tool serializes refreshes behind a lock and writes the rotated token back, but if a
>   refresh races the real CLI you may need to re-run `codex login` / `claude`.
> - Never use this in CI or with shared credentials.
