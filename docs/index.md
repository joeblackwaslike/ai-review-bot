---
layout: home

hero:
  name: "ai-review-bot"
  text: "Five-agent parallel code reviews"
  tagline: "Comment /ai-review on any pull request. Five specialized Claude agents analyze your diff in parallel, merge their findings, and post a single deduplicated review — in seconds."
  actions:
    - theme: brand
      text: Quick Start →
      link: /quick-start
    - theme: alt
      text: View on GitHub
      link: https://github.com/joeblackwaslike/ai-review-bot

features:
  - icon: 🔀
    title: Five agents, one review
    details: Bug detection, error handling, test coverage, security, and code quality agents run in parallel via Promise.allSettled(). Their findings are merged and deduplicated before posting — same line flagged twice becomes one comment.

  - icon: 🛡️
    title: Conservative by design
    details: When two agents disagree on severity, the more conservative finding wins. The final verdict is REQUEST_CHANGES if any agent surfaced a blocking issue, COMMENT otherwise. No false approvals.

  - icon: 📌
    title: Diff-anchored comments
    details: Every inline comment is validated against the actual diff before submission. Comments referencing lines not in the diff are dropped silently — the bot never errors a review over a bad anchor.

  - icon: 💬
    title: Slash-command triggered
    details: Comment /ai-review on any PR. Pass inline instructions — "/ai-review focus on the auth flow" — for targeted deep-dives. Re-run with --force to re-review the same commit.

  - icon: ⚡
    title: Deploy in minutes
    details: Fork, link to Vercel, set 5 env vars, deploy. Works with any GitHub repo your app is installed on. No infrastructure to manage beyond the GitHub App itself.

  - icon: 🔧
    title: Pluggable skill frameworks
    details: Each agent's review framework is a vendored Markdown file in skills/. Add a new framework by dropping in a .md file and adding one line to AGENT_SKILLS in review.ts.
---
