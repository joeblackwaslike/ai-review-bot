# Contributing

## Setup

```bash
git clone https://github.com/joeblackwaslike/ai-review-bot.git
cd ai-review-bot
pnpm install
cp .env.example .env   # fill in your values
```

## Local webhook testing

GitHub can't reach localhost directly. Use [smee.io](https://smee.io) to proxy webhooks:

1. Go to [smee.io](https://smee.io) and create a channel
2. Set your GitHub App's Webhook URL to the smee channel URL
3. Run the forwarder:

```bash
bunx smee-client --url https://smee.io/<your-channel> \
  --target http://localhost:3000/api/github/webhook
```

4. In a separate terminal:

```bash
pnpm dev
```

## Code quality

```bash
pnpm typecheck   # must pass
pnpm lint        # must pass (biome)
pnpm test        # must pass (vitest)
```

All three must pass before opening a PR. To auto-fix lint issues: `pnpm lint -- --write`.

## Docs

```bash
pnpm docs:dev      # live-reload docs at localhost:5173/ai-review-bot/
pnpm docs:build    # production build
pnpm docs:preview  # preview production build locally
```

The docs site deploys automatically to GitHub Pages on every push to `main` that touches `docs/`.

## Pull request

- Use [conventional commits](https://www.conventionalcommits.org/) for commit messages
- One logical change per PR
- Update `CLAUDE.md` and `README.md` if you change behavior, add config options, or add/remove agent skills
- If you add a skill, also update the `AGENT_SKILLS` array in `src/review.ts` and the skills table in both docs
