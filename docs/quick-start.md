# Quick Start

Get your first parallel AI code review in under 10 minutes.

## Prerequisites

- A GitHub account with permission to create GitHub Apps
- A [Vercel](https://vercel.com) account (free tier works)
- An [Anthropic](https://console.anthropic.com) API key

## Step 1 — Create a GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set the app name (e.g. `my-ai-reviewer`)
3. Set **Webhook URL** to a placeholder for now (`https://example.com`) — you'll update this after deploy
4. Set **Webhook secret** to a random string — save it, you'll need it later
5. Grant these permissions:
   - **Pull requests**: Read and write
   - **Contents**: Read-only
   - **Metadata**: Read-only
   - **Issues**: Read-only
6. Subscribe to these events:
   - **Pull request**
   - **Issue comment**
7. Click **Create GitHub App**
8. Note the **App ID** shown at the top of the app settings page
9. Scroll to **Private keys** and click **Generate a private key** — save the downloaded `.pem` file

## Step 2 — Format your private key

Vercel stores secrets as single-line strings. Convert the PEM to a one-liner before adding it:

```bash
awk 'NF {printf "%s\\n", $0}' your-private-key.pem
```

The output will look like `-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----`. Use this string as `GITHUB_APP_PRIVATE_KEY`.

## Step 3 — Deploy to Vercel

**Option A — Vercel dashboard:**

1. Fork this repo on GitHub
2. Go to [vercel.com/new](https://vercel.com/new) and import your fork
3. Set framework preset to **Other**
4. Add environment variables (see [Configuration](/configuration) for all options):

```env
GITHUB_APP_ID=<your app ID>
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----
GITHUB_WEBHOOK_SECRET=<your webhook secret>
ANTHROPIC_API_KEY=sk-ant-...
REVIEW_ENABLED=true
```

5. Click **Deploy** and copy the production URL

**Option B — Vercel CLI:**

```bash
git clone https://github.com/joeblackwaslike/ai-review-bot.git
cd ai-review-bot
vercel link
vercel env add GITHUB_APP_ID
vercel env add GITHUB_APP_PRIVATE_KEY
vercel env add GITHUB_WEBHOOK_SECRET
vercel env add ANTHROPIC_API_KEY
vercel env add REVIEW_ENABLED   # value: true
vercel --prod
```

## Step 4 — Point the webhook at Vercel

Back in your GitHub App settings, update the **Webhook URL** to:

```
https://your-deployment.vercel.app/api/github/webhook
```

Save changes. GitHub will send a ping event — check your Vercel function logs to confirm it arrives.

## Step 5 — Install the app on your repos

1. In your GitHub App settings, click **Install App**
2. Select the repositories you want reviewed

## Step 6 — Trigger your first review

On any open pull request in an installed repo, comment:

```
/ai-review
```

The bot will post a review within 15–60 seconds depending on PR size. Larger diffs (many changed files) take longer because five agents run in parallel, each processing the full diff.

## Verification

After your first review posts, check:

- **`GET /api/health`** — returns `{ "status": "ok" }`
- **`GET /api/debug`** — returns current config (API keys masked)
- **Vercel function logs** — look for `agent results collected` and `merged review` log lines

## Local development

Use [smee.io](https://smee.io) to receive webhooks locally:

```bash
# Terminal 1 — webhook proxy
npx smee-client --url https://smee.io/<your-channel> \
  --target http://localhost:3000/api/github/webhook

# Terminal 2 — local server
cp .env.example .env   # fill in your values
npm run dev
```

Point your GitHub App's Webhook URL at the smee channel URL during development, then switch back to the Vercel URL when you deploy.
