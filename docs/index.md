---
layout: home

hero:
  name: "ai-review-bot"
  text: "Automatic parallel AI code reviews"
  tagline: "Install two GitHub Apps — one powered by Claude, one by Codex — and every pull request gets reviewed automatically. Five specialized agents analyze your diff in parallel, merge their findings, and post a single deduplicated review."
  actions:
    - theme: brand
      text: Quick Start →
      link: /quick-start
    - theme: alt
      text: View on GitHub
      link: https://github.com/joeblackwaslike/ai-review-bot

features:
  - icon: 🤖
    title: Two bots, one deployment
    details: A Claude bot (Anthropic) and a Codex bot (OpenAI) run from a single Vercel deployment. Each is a separate GitHub App with its own icon. Install both and every PR gets two independent expert opinions side by side.

  - icon: ⚡
    title: Automatic on every PR
    details: Reviews fire automatically when a pull request is opened or a new commit is pushed — no slash command needed. Both bots post independently after a short delay (default 7.5 min) that lets other reviewers like Code Rabbit finish first.

  - icon: 🔀
    title: Five agents, one review
    details: Bug detection, error handling, test coverage, security, and code quality agents run in parallel via Promise.allSettled(). Their findings are merged and deduplicated before posting — same line flagged twice becomes one comment.

  - icon: 🔇
    title: Cross-bot deduplication
    details: Before running, each bot reads all existing reviews on the PR — from the other bot and from external tools like Code Rabbit. Agents are instructed not to re-report findings that have already been raised, keeping reviews complementary rather than redundant.

  - icon: 🛡️
    title: Conservative by design
    details: When two agents disagree on severity, the more conservative finding wins. The final verdict is REQUEST_CHANGES if any agent surfaced a blocking issue, COMMENT otherwise. No false approvals.

  - icon: 📌
    title: Diff-anchored comments
    details: Every inline comment is validated against the actual diff before submission. Comments referencing lines not in the diff are dropped silently — the bot never errors a review over a bad anchor.

  - icon: 💬
    title: Manual triggering
    details: Comment /ai-review on any PR to request a review on demand — useful for PRs opened before the apps were installed, or to re-run with extra instructions like "/ai-review focus on the auth flow". Pass --force to re-review the same commit.

  - icon: 📦
    title: CLI & npm package
    details: "Also published to npm: `npx ai-review-bot owner/repo` audits an entire codebase — no PR, no webhook needed. Posts findings as a GitHub issue. Use it on demand, on a schedule, or as a GitHub Action step in any CI workflow."

  - icon: 🔧
    title: Pluggable skill frameworks
    details: Each agent's review framework is a vendored Markdown file in skills/. Add a new framework by dropping in a .md file and adding one line to AGENT_SKILLS in review.ts.
---
